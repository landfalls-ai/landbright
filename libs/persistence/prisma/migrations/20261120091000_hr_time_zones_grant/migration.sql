-- The application role updates only named tenant columns (see 20261112150000_second_factor): the zones too.
GRANT UPDATE ("time_zone", "site_time_zones") ON "tenant" TO landbright_app;
