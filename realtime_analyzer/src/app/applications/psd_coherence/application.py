from __future__ import annotations

import base64
import io
from datetime import datetime
from typing import Optional

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import mne
import numpy as np
from mne_connectivity import spectral_connectivity_epochs
from mne_connectivity.viz import plot_connectivity_circle

from ....config.env import settings
from ...base import AnalysisResult, RealtimeApplication
from ....state import UserState

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

    def analyze(
        self,
        user_id: str,
        state: UserState,
        window: np.ndarray,
    ) -> Optional[AnalysisResult]:
        profile = state.profile
        bad_channels = set(profile.get("bad_channels", []))
        allowed_types = {"eeg", "emg", "eog"}
        analysis_indices = [
            idx
            for idx, (name, ch_type) in enumerate(zip(profile["ch_names"], profile["ch_types"]))
            if ch_type in allowed_types and name not in bad_channels
        ]

        if not analysis_indices:
            if settings.enable_debug_logging:
                print(f"ユーザー({user_id})に解析可能な良好チャネルが存在しません。スキップします。")
            return None

        analysis_channels = [profile["ch_names"][idx] for idx in analysis_indices]

        data_chunk_good = window[:, analysis_indices]
        data_in_volts = data_chunk_good.T.astype(np.float64) * profile["lsb_to_volts"]

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
            fig_psd = raw.compute_psd(
                fmin=1,
                fmax=45,
                n_fft=int(profile["sampling_rate"]),
                verbose=False,
            ).plot(show=False, spatial_colors=True)
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
            print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] ユーザー({user_id})の解析結果を更新しました。")

        return result
