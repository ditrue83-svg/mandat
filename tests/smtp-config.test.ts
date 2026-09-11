import { describe, expect, it } from "vitest";
import { smtpPassword } from "../src/lib/smtp-config";

describe("Password SMTP nei diversi runtime", () => {
  it("decodifica senza espansioni o perdita di caratteri", () => {
    const password = "  p$HOME ${USER} # ' \" ` \\ è 📨  ";
    expect(
      smtpPassword({
        SMTP_PASSWORD_BASE64: Buffer.from(password).toString("base64"),
      }),
    ).toBe(password);
    expect(smtpPassword({ SMTP_PASSWORD: password })).toBe(password);
  });

  it("rifiuta configurazioni ambigue o non valide senza mostrare il segreto", () => {
    const secret = "fixture-private-password";
    for (const env of [
      {},
      { SMTP_PASSWORD: "bad\npassword" },
      { SMTP_PASSWORD: "bad\0password" },
      { SMTP_PASSWORD_BASE64: "not%%%base64" },
      { SMTP_PASSWORD_BASE64: "/w==" },
      { SMTP_PASSWORD_BASE64: "c2VjcmV0\n" },
      { SMTP_PASSWORD_BASE64: "YQ" },
      { SMTP_PASSWORD_BASE64: Buffer.from("bad\rpassword").toString("base64") },
      {
        SMTP_PASSWORD: secret,
        SMTP_PASSWORD_BASE64: Buffer.from(secret).toString("base64"),
      },
    ]) {
      expect(() => smtpPassword(env)).toThrow();
      try {
        smtpPassword(env);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
