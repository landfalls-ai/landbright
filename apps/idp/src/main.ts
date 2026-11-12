import './instrument';
import 'reflect-metadata';
import { loadConfig, startService } from '@landbright/platform';
import { AppModule } from './app.module';

const config = loadConfig();
void startService(AppModule, { name: 'landbright-idp', port: config.LANDBRIGHT_IDP_PORT });
