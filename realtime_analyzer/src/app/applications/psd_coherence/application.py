from __future__ import annotations

import base64
import io
from datetime import datetime

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import mne
import numpy as np
from matplotlib import cm
from mne_connectivity import spectral_connectivity_epochs
from mne_connectivity.viz import plot_connectivity_circle
from numpy.random import default_rng

from ....config.env import settings
from ...state import UserState
from ..base import AnalysisResult, RealtimeApplication


def _fig_to_base64(fig) -> str:
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    buffer.seek(0)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


class PsdCoherenceApplication(RealtimeApplication):
    app_id = "psd_coherence"
    display_name = "PSD & Coherence"
    description = "Power spectral density and coherence visualisation."
    _rng = default_rng()

    def analyze(
        self,
        user_id: str,
        state: UserState,
        window: np.ndarray,
    ) -> AnalysisResult | None:
        profile = state.profile
        bad_channels = set(profile.get("bad_channels", []))
        allowed_types = {"eeg", "emg", "eog"}
        analysis_indices = [
            idx
            for idx, (name, ch_type) in enumerate(
                zip(profile["ch_names"], profile["ch_types"], strict=False)
            )
            if ch_type in allowed_types and name not in bad_channels
        ]

        if not analysis_indices:
            if settings.enable_debug_logging:
                print(
                    f"ユーザー({user_id})に解析可能な良好チャネルが存在しません。スキップします。"
                )
            return None

        analysis_channels = [profile["ch_names"][idx] for idx in analysis_indices]

        data_chunk_good = window[:, analysis_indices]
        raw_signals = data_chunk_good.T.astype(np.float64, copy=False)
        data_in_volts = raw_signals * profile["lsb_to_volts"]

        def build_stats() -> dict[str, dict[str, float]]:
            return {
                ch: {
                    "min": float(data_in_volts[idx].min()),
                    "max": float(data_in_volts[idx].max()),
                    "std": float(data_in_volts[idx].std()),
                }
                for idx, ch in enumerate(analysis_channels)
            }

        channel_stats = build_stats()
        low_variance = [
            (idx, ch) for idx, ch in enumerate(analysis_channels) if channel_stats[ch]["std"] < 1e-9
        ]
        if low_variance:
            low_variance_channels = [ch for _, ch in low_variance]
            print(
                "[Realtime] Low-variance channels detected for user "
                f"{user_id}: {low_variance_channels}. Marking as bad."
            )
            bad_channels.update(low_variance_channels)
            analysis_indices = [
                idx
                for idx, (name, ch_type) in enumerate(
                    zip(profile["ch_names"], profile["ch_types"], strict=False)
                )
                if ch_type in allowed_types and name not in bad_channels
            ]

            if not analysis_indices:
                if settings.enable_debug_logging:
                    print(f"ユーザー({user_id})は低分散チャネルのみのため解析をスキップします。")
                return None

            analysis_channels = [profile["ch_names"][idx] for idx in analysis_indices]
            data_chunk_good = window[:, analysis_indices]
            raw_signals = data_chunk_good.T.astype(np.float64, copy=False)
            data_in_volts = raw_signals * profile["lsb_to_volts"]
            channel_stats = build_stats()

        if settings.enable_debug_logging:
            print(f"[Realtime] PSD input stats for user {user_id}: {channel_stats}")

        info_copy = profile["mne_info"].copy()
        pick_indices = [profile["ch_names"].index(name) for name in analysis_channels]
        analysis_info = mne.pick_info(info_copy, sel=pick_indices, copy=True)
        analysis_info["bads"] = [name for name in bad_channels if name in analysis_channels]

        try:
            raw = mne.io.RawArray(data_in_volts, analysis_info, verbose=False)
        except Exception as exc:
            print(f"ユーザー({user_id})のRaw生成中にエラーが発生しました: {exc}")
            return None

        try:
            fig_psd = raw.plot_psd(
                fmin=1,
                fmax=45,
                average=False,
                spatial_colors=False,
                show=False,
            )
            # recolor lines deterministically by channel index instead of relying on spatial info
            if fig_psd.axes:
                ax = fig_psd.axes[0]
                cmap = cm.get_cmap("tab20")
                color_divisor = max(len(analysis_channels) - 1, 1)
                for idx, line in enumerate(ax.lines[: len(analysis_channels)]):
                    line.set_color(cmap(idx / color_divisor))
            psd_b64 = _fig_to_base64(fig_psd)
        except Exception as exc:
            print(f"ユーザー({user_id})のPSD生成中にエラーが発生しました: {exc}")
            return None

        try:
            epochs = mne.make_fixed_length_epochs(
                raw,
                duration=settings.analysis_window_seconds,
                preload=True,
                verbose=False,
            )
            con = spectral_connectivity_epochs(
                epochs,
                method="coh",
                sfreq=profile["sampling_rate"],
                fmin=8,
                fmax=13,
                faverage=True,
                verbose=False,
            )
            con_matrix = np.squeeze(con.get_data(output="dense"))
            eeg_indices = mne.pick_types(analysis_info, eeg=True)
            eeg_ch_names = [analysis_channels[i] for i in eeg_indices]

            coh_b64 = ""
            if len(eeg_ch_names) > 1:
                fig_coh, _ = plot_connectivity_circle(
                    con_matrix[np.ix_(eeg_indices, eeg_indices)],
                    eeg_ch_names,
                    show=False,
                    vmin=0,
                    vmax=1,
                )
                coh_b64 = _fig_to_base64(fig_coh)
        except Exception as exc:
            print(f"ユーザー({user_id})のコヒーレンス計算中にエラーが発生しました: {exc}")
            coh_b64 = ""

        channel_report = profile.get("channel_report", {})

        result: AnalysisResult = {
            "psd_image": psd_b64,
            "coherence_image": coh_b64,
            "timestamp": datetime.now().isoformat(),
            "bad_channels": sorted(bad_channels),
            "analysis_channels": analysis_channels,
            "channel_quality": channel_report,
        }

        if settings.enable_debug_logging:
            print(
                f"[{datetime.now():%Y-%m-%d %H:%M:%S}] ユーザー({user_id})の解析結果を"
                "更新しました。"
            )

        return result
