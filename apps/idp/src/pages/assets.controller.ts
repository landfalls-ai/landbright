import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '@landbright/platform';
import { STYLESHEET } from './stylesheet';

@Controller('assets')
export class AssetsController {
  // Public: the sign-in pages load it before anyone is signed in. Pages link it with a content hash
  // (STYLESHEET_HREF), so it is immutable.
  @Public()
  @Get('signin.css')
  @Header('content-type', 'text/css; charset=utf-8')
  @Header('cache-control', 'public, max-age=31536000, immutable')
  css(): string {
    return STYLESHEET;
  }
}
