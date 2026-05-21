# MenStation Deployment Guide

MenStation is a Node.js + Express + MySQL app. The backend serves the vanilla JS frontend from `frontend/` and exposes JSON APIs under `/api`.

## Local Setup

1. Install dependencies from the project root:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Fill in `.env`:

```env
NODE_ENV=development
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password
DB_NAME=menstation
JWT_SECRET=replace_with_a_long_random_secret_at_least_32_chars
JWT_EXPIRES_IN=7d
ADMIN_NAME=System Admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace_with_a_unique_password_at_least_12_chars
DEFAULT_BRANCH_NAME=Main Branch
```

4. Create the database schema. Recommended cross-platform command:

```bash
npm run db:setup
```

This reads `.env`, connects to MySQL, creates `DB_NAME` if needed, and imports `database/menstation.sql`.

If you prefer the MySQL CLI on macOS/Linux:

```bash
mysql -u <user> -p < database/menstation.sql
```

On Windows PowerShell, `mysql` must be installed and available in PATH. If it is not, use `npm run db:setup` or call the full path to `mysql.exe`, for example:

```powershell
Get-Content .\database\menstation.sql -Raw | & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```

Common local MySQL paths are:

```text
C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe
C:\xampp\mysql\bin\mysql.exe
C:\laragon\bin\mysql\mysql-8.0\bin\mysql.exe
```

5. Create the first admin account and default branch:

```bash
npm run seed
```

6. Run the system:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The login page is [http://localhost:3000/login.html](http://localhost:3000/login.html).

## Clean Database Reset

For a production-style reset that clears operational data and recreates one admin from `.env`:

```bash
npm run reset:production
```

This leaves services empty by design. Add real services from the admin dashboard; the public site and reservation flow read services dynamically from MySQL.

## GitHub Upload

From the project root:

```bash
git init
git add .
git commit -m "Prepare MenStation for production"
git branch -M main
git remote add origin <repo-url>
git push -u origin main
```

`.env`, `node_modules/`, logs, and generated service uploads are ignored by `.gitignore`.

## Backend Deployment: Render or Railway

Use the project root as the service root.

Recommended settings:

```text
Build command: npm install
Start command: npm start
```

Set environment variables in the host dashboard:

```env
NODE_ENV=production
PORT=3000
DB_HOST=<managed-mysql-host>
DB_PORT=3306
DB_USER=<managed-mysql-user>
DB_PASSWORD=<managed-mysql-password>
DB_NAME=<managed-mysql-database>
JWT_SECRET=<long-random-secret>
JWT_EXPIRES_IN=7d
CORS_ORIGINS=https://your-frontend-domain.example
ADMIN_NAME=System Admin
ADMIN_EMAIL=admin@your-domain.example
ADMIN_PASSWORD=<temporary-strong-password>
```

After the database exists, run `database/menstation.sql` in your MySQL provider, then run `npm run seed` once from a one-off shell/job if the host supports it.

## Frontend Deployment: Same Service, Netlify, or Vercel

The simplest production setup is to let Express serve `frontend/` from the same backend domain. In that case, no frontend API configuration is needed because the browser uses same-origin `/api`.

If you deploy `frontend/` separately on Netlify or Vercel:

1. Set the publish/output directory to `frontend`.
2. Configure the API base URL before the frontend scripts load. Use one of these options:

```html
<meta name="api-base" content="https://your-backend-domain.example/api">
```

or in a small script tag:

```html
<script>
  window.MENSTATION_API_BASE = 'https://your-backend-domain.example/api';
</script>
```

3. Add the frontend origin to backend `CORS_ORIGINS`, for example:

```env
CORS_ORIGINS=https://your-site.netlify.app,https://your-site.vercel.app
```

## Endpoint Checklist

Core endpoints are mounted as JSON APIs:

```text
POST   /api/auth/login
GET    /api/services
GET    /api/public/services
POST   /api/public/reservations
GET    /api/reservations
GET    /api/admin/*
GET    /api/barber/*
GET    /api/staff/*
GET    /api/sales
GET    /api/inventory
GET    /api/health
```

Role-specific writes stay protected by JWT role checks. Public booking uses `/api/public/reservations`; dashboard reservation management uses `/api/reservations` or the role-specific staff routes.
