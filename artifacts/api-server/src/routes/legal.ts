import { Router, type Request, type Response } from "express";

const router = Router();

const LAST_UPDATED = "April 21, 2026";
const COMPANY = "Jesus Christ Temple Ministry (JCTM)";
const PRODUCT = "Temple TV";
const CONTACT_EMAIL = "support@templetv.jctm";

function htmlLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — ${PRODUCT}</title>
<meta name="robots" content="index, follow" />
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f8f5ff;
    color: #1a1a1a;
    line-height: 1.6;
  }
  .container { max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 36px; }
  .logo {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, #6A0DAD, #c026d3);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 800; font-size: 18px;
  }
  h1 { font-size: 32px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 20px; margin-top: 32px; }
  h3 { font-size: 17px; margin-top: 24px; }
  p, li { font-size: 16px; }
  .meta { color: #666; font-size: 14px; }
  a { color: #6A0DAD; }
  ul { padding-left: 22px; }
  hr { border: none; border-top: 1px solid #e5e0f0; margin: 32px 0; }
  footer { margin-top: 64px; color: #888; font-size: 14px; text-align: center; }
</style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">TV</div>
      <div>
        <h1>${title}</h1>
        <div class="meta">${PRODUCT} · Last updated ${LAST_UPDATED}</div>
      </div>
    </header>
    ${body}
    <footer>
      © ${new Date().getFullYear()} ${COMPANY}. All rights reserved. ·
      <a href="/legal/privacy">Privacy</a> ·
      <a href="/legal/terms">Terms</a>
    </footer>
  </div>
</body>
</html>`;
}

const PRIVACY_BODY = `
<p>This Privacy Policy explains how ${COMPANY} ("we", "us", "our") collects,
uses, and protects information when you use the ${PRODUCT} mobile application,
TV application, web experiences, and related services (the "Service").</p>

<h2>1. Information we collect</h2>
<ul>
  <li><strong>Account information.</strong> When you create an account, we
    collect your email address, display name, and an encrypted password hash.
    You may optionally upload a profile picture.</li>
  <li><strong>Usage data.</strong> We collect your favorites, watch history
    (including playback progress), and content interactions so the Service can
    sync across your devices.</li>
  <li><strong>Push notification token.</strong> When you opt in to
    notifications we store your device push token so we can alert you when a
    live broadcast begins or new content is published.</li>
  <li><strong>Diagnostic data.</strong> We collect crash reports and
    application errors (error message, stack trace, app version, platform) to
    diagnose and fix problems. This data does not contain your account
    credentials.</li>
  <li><strong>Technical logs.</strong> Our servers receive routine HTTP
    request metadata (IP address, user agent, timestamps). Authorization
    headers and cookies are redacted from our logs.</li>
</ul>

<h2>2. Information we do not collect</h2>
<ul>
  <li>We do not collect precise geolocation.</li>
  <li>We do not access your microphone, camera, contacts, or calendar.</li>
  <li>We do not sell your personal information.</li>
  <li>We do not use third-party advertising networks or behavioral ad tracking.</li>
</ul>

<h2>3. How we use your information</h2>
<ul>
  <li>To provide and maintain the Service (account login, content playback,
    sync of favorites and history).</li>
  <li>To send you notifications you have opted in to.</li>
  <li>To detect, investigate, and prevent abuse, fraud, and security issues.</li>
  <li>To comply with our legal obligations.</li>
</ul>

<h2>4. Security</h2>
<p>Authentication tokens on iOS are stored in the iOS Keychain; on Android in
EncryptedSharedPreferences. Passwords are stored as bcrypt hashes — never in
plain text. Communication with our servers uses HTTPS with HSTS, and our API
enforces strict transport security headers and a Content-Security-Policy.</p>

<h2>5. Data retention</h2>
<p>You may delete your account at any time from the in-app account settings.
When you delete your account, we permanently delete your personal account
information, favorites, history, and push token within 30 days. Anonymized
diagnostic data may be retained longer for trend analysis.</p>

<h2>6. Children's privacy</h2>
<p>The Service is intended for general audiences. We do not knowingly collect
personal information from children under 13. If you believe a child has
provided us with personal information, please contact us at
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

<h2>7. Your rights</h2>
<p>Depending on your jurisdiction, you may have the right to access, correct,
export, or delete your personal information. To exercise these rights, contact
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

<h2>8. Third parties</h2>
<p>We use the following third-party services to operate ${PRODUCT}:</p>
<ul>
  <li><strong>YouTube</strong> — to surface live broadcasts and embedded video
    playback. YouTube's privacy policy applies to playback within their
    embedded player.</li>
  <li><strong>Push notification providers</strong> (Apple Push Notification
    service for iOS, Firebase Cloud Messaging for Android) — to deliver
    notifications you have opted in to.</li>
</ul>

<h2>9. Changes to this policy</h2>
<p>We may update this policy from time to time. The "Last updated" date at the
top of this page reflects the latest revision. Material changes will be
communicated in-app.</p>

<h2>10. Contact</h2>
<p>Questions or requests regarding this policy should be sent to
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

const TERMS_BODY = `
<p>These Terms of Service ("Terms") govern your access to and use of
${PRODUCT}, operated by ${COMPANY} ("we", "us"). By creating an account or
otherwise using the Service, you agree to these Terms.</p>

<h2>1. Eligibility</h2>
<p>You must be at least 13 years old to use the Service. By using the Service
you represent that you meet this requirement and that you have the legal
capacity to enter into these Terms.</p>

<h2>2. Account responsibility</h2>
<p>You are responsible for safeguarding your account credentials and for any
activity that occurs under your account. Notify us immediately at
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> if you suspect
unauthorized use.</p>

<h2>3. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
  <li>Reverse engineer, decompile, or attempt to extract the source code of
    the Service;</li>
  <li>Interfere with or disrupt the Service or its underlying infrastructure;</li>
  <li>Use the Service to transmit unlawful, harassing, or infringing content;</li>
  <li>Use automated means to access the Service in violation of our published
    rate limits.</li>
</ul>

<h2>4. Content and intellectual property</h2>
<p>All sermons, broadcasts, recordings, logos, and graphics are the property
of ${COMPANY} or its licensors and are protected by copyright and other
intellectual-property laws. The Service grants you a personal, non-exclusive,
non-transferable, revocable license to access and view the content for
personal, non-commercial use.</p>

<h2>5. Live broadcasts and third-party content</h2>
<p>Live broadcasts and certain video content may be embedded from YouTube.
Such content is subject to YouTube's own terms of service. We do not control
and are not responsible for the availability, accuracy, or behavior of
third-party services.</p>

<h2>6. Donations</h2>
<p>Any donations made through the Service are voluntary and non-refundable
except where required by law. Donations are processed by third-party payment
providers, whose terms apply to payment handling.</p>

<h2>7. Disclaimer of warranties</h2>
<p>The Service is provided "as is" and "as available" without warranties of
any kind, whether express or implied, including merchantability, fitness for
a particular purpose, and non-infringement. We do not warrant that the
Service will be uninterrupted, error-free, or that defects will be corrected.</p>

<h2>8. Limitation of liability</h2>
<p>To the maximum extent permitted by law, in no event shall ${COMPANY}, its
officers, directors, employees, or affiliates be liable for any indirect,
incidental, special, consequential, or punitive damages arising out of or
related to your use of the Service.</p>

<h2>9. Termination</h2>
<p>We may suspend or terminate your access to the Service at any time, with
or without notice, for conduct that we reasonably believe violates these
Terms or is otherwise harmful to other users or to us. You may terminate your
account at any time from the in-app settings.</p>

<h2>10. Changes to the Service and Terms</h2>
<p>We may modify the Service or these Terms at any time. Continued use of the
Service after such changes constitutes acceptance of the modified Terms. The
"Last updated" date at the top of this page reflects the latest revision.</p>

<h2>11. Governing law</h2>
<p>These Terms are governed by the laws of the jurisdiction in which
${COMPANY} is established, without regard to conflict-of-laws principles.</p>

<h2>12. Contact</h2>
<p>Questions about these Terms should be sent to
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;

function sendLegal(res: Response, title: string, body: string) {
  // Override the strict global CSP for these HTML pages so inline <style> works.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(htmlLayout(title, body));
}

router.get("/legal/privacy", (_req: Request, res: Response) => {
  sendLegal(res, "Privacy Policy", PRIVACY_BODY);
});

router.get("/legal/terms", (_req: Request, res: Response) => {
  sendLegal(res, "Terms of Service", TERMS_BODY);
});

router.get("/legal", (_req: Request, res: Response) => {
  sendLegal(
    res,
    "Legal",
    `<p>Please review our:</p>
     <ul>
       <li><a href="/legal/privacy">Privacy Policy</a></li>
       <li><a href="/legal/terms">Terms of Service</a></li>
     </ul>`,
  );
});

export default router;
