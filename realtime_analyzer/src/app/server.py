from __future__ import annotations

from flask import Flask, jsonify

from .applications.psd_coherence import PsdCoherenceApplication
from .host import RealtimeApplicationHost

app = Flask(__name__)

host = RealtimeApplicationHost()
host.register_application(PsdCoherenceApplication())
host.start_background_threads()


@app.route("/health", methods=["GET"])
def health_check():
    status = "ok" if host.rabbitmq_connected() else "unhealthy"
    status_code = 200 if status == "ok" else 503
    return jsonify({"status": status}), status_code


@app.route("/api/v1/applications", methods=["GET"])
def list_applications():
    return jsonify({"applications": host.get_applications_summary()})


@app.route("/api/v1/users/<user_id>/analysis", methods=["GET"])
def get_analysis_results(user_id: str):
    user_results = host.get_user_results(user_id)
    if not user_results:
        return jsonify({"status": f"ユーザー({user_id})の解析結果はまだありません..."}), 202
    response = {
        "applications": user_results,
        "available_applications": host.get_applications_summary(),
    }
    return jsonify(response)


def start_realtime_analyzer() -> Flask:
    host.start_background_threads()
    return app


if __name__ == "__main__":
    print("Flask APIサーバーを http://0.0.0.0:5002 で起動します（開発モード）。")
    app.run(host="0.0.0.0", port=5002)
