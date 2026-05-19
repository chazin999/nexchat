# 💬 NexChat

Chat em tempo real com Socket.io, Express e MongoDB.

## Deploy no Railway

1. Suba este repositório no GitHub
2. Acesse [railway.app](https://railway.app) → login com GitHub → New Project → Deploy from GitHub repo
3. Adicione as variáveis de ambiente:

| Variável | Valor |
|----------|-------|
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster.mongodb.net/nexchat` |
| `PORT` | `3000` |
| `SESSION_SECRET` | qualquer string longa aleatória |
| `APP_URL` | URL gerada pelo Railway |

4. Clique em Deploy ✅

## Rodar localmente

```bash
npm install
cp .env.example .env
# Edite .env com seu MONGODB_URI
npm start
```
