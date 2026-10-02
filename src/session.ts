import { CookieJar } from "tough-cookie";
import { z } from "zod";

const savedState = z.object({
  version: z.literal(1),
  cookieJar: z.record(z.string(), z.unknown()),
});

export class SessionCookies {
  private readonly jar: CookieJar;

  constructor(jar = new CookieJar()) {
    this.jar = jar;
  }

  static async load(value: unknown) {
    const saved = savedState.parse(value);
    return new SessionCookies(await CookieJar.deserialize(saved.cookieJar));
  }

  async cookies(url: string) {
    return (await this.jar.getCookies(url)).map((cookie) => ({
      name: cookie.key,
      value: cookie.value,
    }));
  }

  async receiveCookies(url: string, headers: Headers) {
    for (const cookie of headers.getSetCookie()) {
      await this.jar.setCookie(cookie, url, { ignoreError: true });
    }
  }

  toJSON() {
    return { version: 1, cookieJar: this.jar.toJSON() };
  }
}
