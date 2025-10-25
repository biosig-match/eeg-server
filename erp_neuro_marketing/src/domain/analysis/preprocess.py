import logging
from pathlib import Path

import mne
import pandas as pd
from mne_bids import BIDSPath, read_raw_bids

# --- ロガー設定 ---
logger = logging.getLogger(__name__)


def _sanitize_task_name(raw_task: str | None, default_task: str) -> str:
    """Sanitize the task name to match the naming used during BIDS export."""
    candidate = (raw_task or "").strip()
    if not candidate:
        candidate = default_task

    sanitized = candidate.replace("_", "").replace("-", "").replace(" ", "")
    return sanitized or "defaulttask"


def create_epochs_from_bids(
    bids_root_path: Path,
    sessions_df: pd.DataFrame,
    default_task: str,
    tmin: float = -0.2,
    tmax: float = 0.8,
    baseline: tuple | None = (-0.2, 0),
) -> mne.Epochs | None:
    """
    BIDSデータセットからMNEのEpochsオブジェクトを生成・結合する。

    :param bids_root_path: BIDSデータセットのルートディレクトリのパス
    :param sessions_df: 対象となるセッション情報を含むDataFrame ('session_id', 'user_id')
    :param default_task: BIDSの task エンティティ名の初期値 (例: 'calibration', 'main')
    :param tmin: Epochの開始時間 (秒)
    :param tmax: Epochの終了時間 (秒)
    :param baseline: ベースライン補正の期間 (秒)
    :return: 結合されたMNE Epochsオブジェクト。対象データがない場合はNone。
    """
    all_epochs = []

    for row in sessions_df.itertuples(index=False):
        subject_id = row.user_id.replace("-", "")
        session_index = getattr(row, "session_index", None)
        if session_index is None:
            logger.warning(
                "Session %s is missing a session_index. Skipping as BIDS alignment is ambiguous.",
                getattr(row, "session_id", "unknown"),
            )
            continue

        session_label = str(session_index)
        task_name = _sanitize_task_name(getattr(row, "session_type", None), default_task)

        try:
            bids_path = BIDSPath(
                subject=subject_id,
                session=session_label,
                task=task_name,
                datatype="eeg",
                root=bids_root_path,
            )

            logger.info("Reading BIDS data from: %s", bids_path.directory)
            raw = read_raw_bids(bids_path=bids_path, verbose=False)
            raw = raw.copy()

            bad_channels = raw.info.get("bads", [])
            if bad_channels:
                if len(bad_channels) >= len(raw.ch_names):
                    logger.warning(
                        "All channels for sub-%s, ses-%s are marked bad. Skipping session.",
                        subject_id,
                        session_label,
                    )
                    continue
                logger.info("Dropping bad channels for subject %s: %s", subject_id, bad_channels)
                raw.drop_channels(bad_channels)

            picks = mne.pick_types(raw.info, eeg=True, eog=True, emg=True, meg=False, stim=False)
            if len(picks) == 0:
                logger.warning(
                    "No usable EEG/EMG/EOG channels remain after dropping bad channels for %s. "
                    "Skipping.",
                    bids_path,
                )
                continue
            raw.pick(picks=picks)

            events_path = bids_path.copy().update(suffix="events", extension=".tsv")
            if not events_path.fpath.exists():
                logger.warning("No events file found for %s. Skipping this session.", bids_path)
                continue

            events_df = pd.read_csv(events_path.fpath, sep="\t")

            events = []
            event_id_map = {}

            unique_trial_types = events_df["trial_type"].unique()
            for idx, trial_type in enumerate(unique_trial_types, 1):
                event_id_map[trial_type] = idx

            for _, event_row in events_df.iterrows():
                onset_sample = int(event_row["onset"] * raw.info["sfreq"])
                event_id = event_id_map[event_row["trial_type"]]
                events.append([onset_sample, 0, event_id])

            if not events:
                logger.warning("No events could be parsed for %s. Skipping.", bids_path)
                continue

            metadata_df = events_df[["trial_type", "stim_file"]].copy()
            metadata_df["stim_file"] = metadata_df["stim_file"].fillna("n/a")
            metadata_df["session_id"] = row.session_id
            metadata_df["user_id"] = row.user_id
            metadata_df["session_type"] = getattr(row, "session_type", default_task)

            epochs = mne.Epochs(
                raw,
                events=events,
                event_id=event_id_map,
                tmin=tmin,
                tmax=tmax,
                baseline=baseline,
                preload=True,
                metadata=metadata_df,
                verbose=False,
            )
            all_epochs.append(epochs)
            logger.info(
                "Successfully created %s epochs for sub-%s, ses-%s, task-%s",
                len(epochs),
                subject_id,
                session_label,
                task_name,
            )

        except FileNotFoundError:
            logger.warning(
                "BIDS data not found for subject '%s', session '%s', task '%s'. Skipping.",
                subject_id,
                session_label,
                task_name,
            )
            continue
        except Exception as e:
            logger.error(
                "Error processing BIDS data for sub-%s, ses-%s: %s",
                subject_id,
                session_label,
                e,
            )
            import traceback

            traceback.print_exc()
            continue

    if not all_epochs:
        logger.warning("No epochs were created for task '%s'.", default_task)
        return None

    # すべてのEpochsを結合して返す
    logger.info(f"Concatenating a total of {len(all_epochs)} Epochs objects.")
    return mne.concatenate_epochs(all_epochs, verbose=False)
