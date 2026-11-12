-- Runs once, when the volume is first created. The app database is POSTGRES_DB (landbright); integration tests use
-- their own database so they never touch development data.
CREATE DATABASE landbright_test OWNER landbright;
