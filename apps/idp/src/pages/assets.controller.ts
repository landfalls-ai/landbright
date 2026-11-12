import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '@landbright/platform';
import { PASSKEY_SCRIPT } from './passkey-script';
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

  // Public for the same reason: the passkey buttons on the sign-in pages. Linked as PASSKEY_SCRIPT_HREF.
  @Public()
  @Get('passkey.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  @Header('cache-control', 'public, max-age=31536000, immutable')
  js(): string {
    return PASSKEY_SCRIPT;
  }
}
