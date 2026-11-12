import { readFileSync } from 'node:fs';
import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '@landbright/platform';
import { SIGNIN_CSS } from './signin-css';

const STYLESHEET = `${readFileSync(require.resolve('@land/tokens/tokens.css'), 'utf8')}\n${SIGNIN_CSS}`;

@Controller('assets')
export class AssetsController {
  // Public: the sign-in pages load it before anyone is signed in.
  @Public()
  @Get('signin.css')
  @Header('content-type', 'text/css; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  css(): string {
    return STYLESHEET;
  }
}
