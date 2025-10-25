import re
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import mne
from mne_bids import BIDSPath, read_raw_bids


def analyze_bids_data(bids_root_path: Path):
    """
    指定されたBIDSルートディレクトリから最初の被験者・セッション・タスクのデータを読み込み、
    脳波形、パワースペクトル密度（PSD）、イベント情報をプロットして画像として保存します。
    """
    if not bids_root_path.exists() or not bids_root_path.is_dir():
        print(f"❌ Error: The specified BIDS root directory does not exist: {bids_root_path}")
        sys.exit(1)

    print(f"🔍 Analyzing BIDS data in: {bids_root_path}")

    try:
        # --- ★★★ ここから修正しました ★★★ ---

        # 1. BIDSルートから最初の被験者ディレクトリを見つける
        subjects = [
            d.name.split("-")[1]
            for d in bids_root_path.iterdir()
            if d.is_dir() and d.name.startswith("sub-")
        ]
        if not subjects:
            print("❌ Error: No subjects found in the BIDS directory.")
            sys.exit(1)
        subject_id = subjects[0]
        subject_path = bids_root_path / f"sub-{subject_id}"

        # 2. 被験者ディレクトリから最初のセッションディレクトリを見つける
        sessions = [
            d.name.split("-")[1]
            for d in subject_path.iterdir()
            if d.is_dir() and d.name.startswith("ses-")
        ]
        if not sessions:
            print(f"❌ Error: No sessions found for subject '{subject_id}'.")
            sys.exit(1)
        session_id = sessions[0]

        # 3. eegディレクトリ内のファイル名から最初のタスク名を見つける
        eeg_dir = subject_path / f"ses-{session_id}" / "eeg"
        task_name = None
        for f in eeg_dir.glob("*_eeg.edf"):
            match = re.search(r"task-([a-zA-Z0-9]+)_", f.name)
            if match:
                task_name = match.group(1)
                break

        if not task_name:
            print(f"❌ Error: No task found for subject '{subject_id}', session '{session_id}'.")
            sys.exit(1)

        # 4. すべての要素を使って、完全なBIDSPathを作成する
        bids_path = BIDSPath(
            subject=subject_id,
            session=session_id,
            task=task_name,
            root=bids_root_path,
            datatype="eeg",
        )

        # --- ★★★ 修正はここまで ★★★ ---

        print(
            f"🧠 Found subject '{subject_id}', session '{session_id}', "
            f"and task '{task_name}'. Loading raw data..."
        )

        raw = read_raw_bids(bids_path=bids_path, verbose=False)

        print("\n✅ Data loaded successfully! Here is the summary:")
        print("-" * 50)
        print(raw)
        print("-" * 50)

        # 出力ファイル名にタスク名も追加
        base_filename = f"sub-{subject_id}_ses-{session_id}_task-{task_name}"

        # 1. 生波形のプロット
        print("📈 Generating raw waveform plot...")
        fig_raw = raw.plot(show=False, duration=10, n_channels=8, scalings=dict(eeg=100e-6))
        raw_plot_path = bids_root_path / f"{base_filename}_raw_plot.png"
        fig_raw.savefig(raw_plot_path, dpi=150)
        plt.close(fig_raw)
        print(f"   -> Saved to: {raw_plot_path}")

        # 2. パワースペクトル密度 (PSD) のプロット
        print("📊 Generating Power Spectral Density (PSD) plot...")
        fig_psd = raw.compute_psd(fmax=50).plot(show=False)
        psd_plot_path = bids_root_path / f"{base_filename}_psd_plot.png"
        fig_psd.savefig(psd_plot_path, dpi=150)
        plt.close(fig_psd)
        print(f"   -> Saved to: {psd_plot_path}")

        # 3. イベント（アノテーション）のプロット
        if raw.annotations and len(raw.annotations) > 0:
            print("📌 Generating events plot...")
            fig_events = raw.plot(
                show=False, events=mne.events_from_annotations(raw)[0], scalings=dict(eeg=100e-6)
            )
            events_plot_path = bids_root_path / f"{base_filename}_events_plot.png"
            fig_events.savefig(events_plot_path, dpi=150)
            plt.close(fig_events)
            print(f"   -> Saved to: {events_plot_path}")
        else:
            print("ℹ️ No events (annotations) found in the data.")

        print("\n🎉 Analysis complete! Check the generated PNG files in the bids_output directory.")

    except Exception as e:
        print(f"\n❌ An error occurred during analysis: {e}")
        print(
            "   Please ensure the BIDS data was generated correctly and all required"
            " libraries are installed."
        )


if __name__ == "__main__":
    bids_root_path = Path(
        "integration_test/test-output/bids_task_0c98a311-f98d-4f84-b731-6d2610e04502/bids_dataset"
    )
    analyze_bids_data(bids_root_path)
