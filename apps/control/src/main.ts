import './instrument';
import 'reflect-metadata';
import { loadConfig, startService } from '@landbright/platform';
import { AppModule } from './app.module';
import { configureControl } from './configure';

const config = loadConfig();
void startService(AppModule, {
  name: 'landbright-control',
  port: config.LANDBRIGHT_CONTROL_PORT,
  configure: configureControl,
});
