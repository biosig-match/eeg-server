import os
import pickle
import numpy as np
import mne
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from mne.decoding import Vectorizer

class ErpDetector:
    """Trains an ERP detection model."""
    def __init__(self, epochs: mne.Epochs, save_path: str):
        self.epochs = epochs
        self.save_path = save_path
        self.clf = self._train()
        self._save_model()

    def _train(self):
        X = self.epochs.get_data(picks='eeg')
        y = self.epochs.events[:, -1]

        # MNEのデコーディングパイプラインを使用
        clf_pipeline = make_pipeline(
            Vectorizer(),       # (n_epochs, n_channels, n_times) -> (n_epochs, n_features)
            StandardScaler(),   # スケーリング
            LogisticRegression(solver='liblinear', random_state=42)
        )

        #層化K分割交差検証
        cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        
        # モデルを訓練
        clf_pipeline.fit(X, y)
        
        print("Model training completed.")
        return clf_pipeline

    def _save_model(self):
        os.makedirs(self.save_path, exist_ok=True)
        model_file = os.path.join(self.save_path, "model.pkl")
        with open(model_file, 'wb') as f:
            pickle.dump(self.clf, f)
        print(f"Model saved to {model_file}")

class EmoSpecEstimator:
    """Estimates emotion spectrum using a pre-trained ERP model."""
    def __init__(self, clf, epochs: mne.Epochs):
        self.clf = clf
        self.epochs = epochs
        self.result = self._predict()

    def _predict(self):
        X = self.epochs.get_data(picks='eeg')
        # Positive class (target) の確率を予測
        # event_idのマッピングに注意。'target'が1, 'nontarget'が0など。
        # ここでは単純にpredict()を使い、陽性クラスを1と仮定
        predictions = self.clf.predict(X)
        return predictions
