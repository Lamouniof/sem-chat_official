import time
import json
import os
import socket
from flask import Flask, render_template
from flask_socketio import SocketIO, emit, join_room
from zeroconf import ServiceInfo, Zeroconf

app = Flask(__name__)
app.config['SECRET_KEY'] = 'chat_ultra_pro_2026'
socketio = SocketIO(app, cors_allowed_origins="*", allow_unsafe_werkzeug=True, max_http_buffer_size=50 * 1024 * 1024)

DATA_FILE = 'chat_data.json'
ADMIN_NAME = "sem-chat"

data_storage = {
    "users": {},
    "general_history": [],
    "private_history": {},
    "leaderboard": []  # Format: [{"pseudo": "...", "score": 0}, ...]
}


def register_mdns(port):
    custom_hostname = "sem-chat"
    local_ip = socket.gethostbyname(socket.gethostname())
    service_name = f"{custom_hostname}._http._tcp.local."
    info = ServiceInfo("_http._tcp.local.", service_name, addresses=[socket.inet_aton(local_ip)], port=port,
                       properties={}, server=f"{custom_hostname}.local.")
    zeroconf = Zeroconf()
    zeroconf.register_service(info)
    return zeroconf, info


def load_data():
    global data_storage
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                data_storage = json.load(f)
                if "leaderboard" not in data_storage: data_storage["leaderboard"] = []
        except:
            pass


def save_data():
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data_storage, f, indent=4, ensure_ascii=False)


load_data()
online_users = {}


@app.route('/')
def index():
    return render_template('index.html')


@socketio.on('login_register')
def handle_auth(data):
    pseudo = data['pseudo'].strip()
    mdp = data['mdp'].strip()
    if not pseudo: return

    is_admin = (pseudo == ADMIN_NAME)

    # 1. Vérification de l'existence du compte et du mot de passe
    if pseudo in data_storage["users"]:
        if data_storage["users"][pseudo] != mdp:
            emit('auth_response', {'success': False, 'message': 'Mauvais mot de passe !'})
            return

        # 2. EMPECHER LA DOUBLE CONNEXION
        # On vérifie si le pseudo est déjà dans le dictionnaire des utilisateurs actifs
        if pseudo in online_users:
            emit('auth_response', {'success': False, 'message': 'Ce compte est déjà connecté sur un autre appareil.'})
            return
    else:
        # Création du compte si inexistant
        data_storage["users"][pseudo] = mdp
        save_data()

    # Si on arrive ici, l'utilisateur peut se connecter
    online_users[pseudo] = time.time()
    join_room(pseudo)
    emit('auth_response', {'success': True, 'pseudo': pseudo, 'is_admin': is_admin})
    emit('load_history', data_storage["general_history"])
    emit('update_users', list(online_users.keys()), broadcast=True)


@socketio.on('message')
def handle_message(data):
    user = data['user']
    target = data.get('target', 'Général')
    data['id'] = int(time.time() * 1000)
    if target == 'Général':
        data_storage["general_history"].append(data)
        if len(data_storage["general_history"]) > 100: data_storage["general_history"].pop(0)
        emit('message', data, broadcast=True)
    else:
        room_key = "-".join(sorted([user, target]))
        if room_key not in data_storage["private_history"]: data_storage["private_history"][room_key] = []
        data_storage["private_history"][room_key].append(data)
        emit('private_message', data, room=target)
        emit('private_message', data, room=user)
    save_data()


@socketio.on('save_score')
def handle_score(data):
    pseudo = data.get('pseudo')
    score = data.get('score', 0)
    if not pseudo: return

    # Mise à jour du leaderboard
    data_storage["leaderboard"].append({"pseudo": pseudo, "score": score})
    # Trier par score décroissant et garder le top 10
    data_storage["leaderboard"] = sorted(data_storage["leaderboard"], key=lambda x: x['score'], reverse=True)[:10]
    save_data()
    emit('update_leaderboard', data_storage["leaderboard"], broadcast=True)


@socketio.on('get_leaderboard')
def send_leaderboard():
    emit('update_leaderboard', data_storage.get("leaderboard", []))


@socketio.on('delete_message')
def delete_message(msg_id, requester_pseudo):
    if requester_pseudo == ADMIN_NAME:
        data_storage["general_history"] = [m for m in data_storage["general_history"] if m.get('id') != msg_id]
        for key in data_storage["private_history"]:
            data_storage["private_history"][key] = [m for m in data_storage["private_history"][key] if
                                                    m.get('id') != msg_id]
        save_data()
        emit('message_deleted', msg_id, broadcast=True)


@socketio.on('ban_user')
def ban_user(data):
    if data['requester'] == ADMIN_NAME and data['target'] != ADMIN_NAME:
        if data['target'] in data_storage["users"]: del data_storage["users"][data['target']]
        if data['target'] in online_users: del online_users[data['target']]
        save_data()
        emit('user_banned_notice', data['target'], broadcast=True)
        emit('update_users', list(online_users.keys()), broadcast=True)


@socketio.on('get_private_history')
def send_private_history(data):
    room_key = "-".join(sorted([data['user'], data['target']]))
    history = data_storage["private_history"].get(room_key, [])
    emit('load_private_history', {'target': data['target'], 'history': history})


@socketio.on('heartbeat')
def handle_heartbeat(pseudo):
    online_users[pseudo] = time.time()
    emit('update_users', list(online_users.keys()), broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    # On cherche quel utilisateur s'est déconnecté (si vous stockez le lien sid/pseudo)
    # Ou plus simplement, le heartbeat s'en chargera si vous nettoyez les vieux timestamps
    pass
if __name__ == '__main__':
    PORT = 5000
    zc, info = register_mdns(PORT)
    try:
        socketio.run(app, host='0.0.0.0', port=PORT, debug=False, allow_unsafe_werkzeug=True)
    finally:
        zc.unregister_service(info); zc.close()