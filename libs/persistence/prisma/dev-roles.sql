-- Development only: lets the app role sign in with the development password from .env.example. The migrations create
-- landbright_app without a password (NOLOGIN), so a real deployment sets its own.
ALTER ROLE landbright_app LOGIN PASSWORD 'landbright-app-dev-only';
