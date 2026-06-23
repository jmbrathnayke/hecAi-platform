# HEC AI E-Governance Platform

AI-driven Human-Elephant Conflict damage assessment and compensation management system for Sri Lanka.

## Stack

- **Frontend**: Next.js 15 PWA (Vercel)
- **Backend**: Python Flask (Render / Azure App Service)
- **Database + Auth**: Supabase (PostgreSQL + Google OAuth)
- **Photo Storage**: Vercel Blob (testing) / Azure Blob Storage (production)

## Setup

### Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- Git

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
# Fill in Supabase keys in .env.local
npm run dev
```

### Backend

```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate
# Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in database and Supabase JWT secret in .env
flask --app wsgi:app run
```

## Planning Docs

See `../_bmad-output/` for architecture, PRD, and all sprint stories.
# hecAi-platform
