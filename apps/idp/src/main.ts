import './instrument';
import 'reflect-metadata';
import { loadConfig, startService } from '@landbright/platform';
import { AppModule } from './app.module';
import { configureIdp, IDP_HELMET } from './configure';

const config = loadConfig();
void startService(AppModule, {
  name: 'landbright-idp',
  port: config.LANDBRIGHT_IDP_PORT,
  bodyParser: false,
  helmet: IDP_HELMET,
  configure: configureIdp,
});
