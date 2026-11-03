# Spike: transactional email provider (E1, #206)

Date: 3 November 2026. Author: Claude B (research-dev). Status: **recommendation for the owner to accept**.

JobFlow M6 needs transactional email only: verification, password reset, "account exists", trial reminders,
extension decisions and operator notices. Volume is small: at pilot scale under 1,000 emails a month, and 100,000 a
month would mean several thousand active companies. There's no marketing email. The sender is
`jobflow@shivomsangha.com`. Requirements: [E1 in public-signup-trial.md](../requirements/public-signup-trial.md);
design: [ADR 0004 D7](../adr/0004-public-signup-and-trial.md).

## Recommendation

**Amazon SES in Sydney (`ap-southeast-2`)**, pay-as-you-go ("à la carte") pricing, with one configuration set per
environment, bounce and complaint events delivered through Amazon SNS, and a send-only IAM key per environment.

Why:

1. **Data stays in Australia.** SES in `ap-southeast-2` sends and stores sending data in Sydney. The other two
   candidates store account data, logs and message metadata in the United States.
2. **Cost.** $0.10 per 1,000 emails, about $1 a month at 10,000 emails. That's the lowest of the three at every volume
   above Resend's free tier.
3. **Signed callbacks.** SNS signs every message with an AWS certificate, which meets the `withWebhook` signature rule
   from the #238 review. Postmark has no payload signatures at all.
4. **Fits the platform.** The staging and production document buckets are already planned for `ap-southeast-2`
   ([staging.md](../ops/staging.md)), so the owner already needs an AWS account there, with one bill.

What SES costs in effort, compared with the other two:

- **Sandbox.** A new account is in the SES sandbox and can only send to verified addresses. The owner requests
  production access once, describing transactional use and bounce handling. AWS usually answers within about a day.
- **Bounce handling is ours.** We already build it (`email_suppressions`, ADR 0004 D7). SES also keeps an
  account-level suppression list, which stays on as a second layer.
- **No internationalised local parts** (see SMTPUTF8 below).
- **No templates or dashboards worth using.** We don't need them, because templates live in the app.

Choose **Resend** instead if the owner wants no AWS dependency for email and accepts US data storage. Its free tier
(3,000 a month, 100 a day) covers the pilot, and its webhooks are signed (Svix). Postmark is not recommended: it has
the strongest deliverability reputation, but it's the most expensive, US-only, and has no webhook signatures.

## Comparison

Prices are in USD, as published on 3 November 2026 (sources at the end). They exclude tax.

| | **Amazon SES (Sydney)** | **Postmark** | **Resend** |
|---|---|---|---|
| Data location | `ap-southeast-2` (Sydney): sending and event data stay in the region | United States only; no other region offered (per a competitor's comparison, not independently confirmed) | Sends from us-east-1, eu-west-1, sa-east-1 or ap-northeast-1 (Tokyo). **Account data, logs and metadata are stored in the US** whatever the sending region |
| Processing terms | AWS Data Processing Addendum (in the AWS Service Terms, GDPR-grade) | DPA available (GDPR) | DPA available (GDPR) |
| Cost, 1,000/month | $0.10 | $15 (smallest paid plan is 10,000; the free plan is 100 a month and can't go over) | $0 (free: 3,000 a month, 100 a day) |
| Cost, 10,000/month | $1.00 | $15 (Basic) | $20 (Pro, 50,000 included) |
| Cost, 100,000/month | $10.00 | $115 (Basic, 125,000 tier; no 100,000 tier) | $35 (Pro, 100,000) |
| Other charges | $0.12 per GB of attachments (we send none); dedicated IP $24.95/month (not needed) | Dedicated IP $50/month (needs Pro and 300,000+ a month) | Dedicated IP $30/month add-on (Scale plan) |
| Deliverability | Shared IP pools, Easy DKIM (2048-bit), custom MAIL FROM for SPF alignment, account suppression list; optional Virtual Deliverability Manager ($0.07 per 1,000) | Best reputation for transactional mail; transactional streams kept apart from broadcast | Shared pools, DKIM/SPF set-up, deliverability insights |
| Bounce and complaint webhooks | SES configuration set → **SNS topic** → HTTPS subscription. Each message is **signed** (SignatureVersion 2, SHA-256, AWS X.509 certificate) | Webhooks with **no HMAC signature**: protection is Basic Auth in the URL, an IP allowlist or a custom header | Webhooks **signed by Svix** (`svix-id`, `svix-timestamp`, `svix-signature`; HMAC over the raw body) |
| API key scoping | IAM policy: `ses:SendEmail` only, limited to one identity, one configuration set and `ses:FromAddress = jobflow@shivomsangha.com`; one key per environment | Server API token per "server" (one per environment); account token kept separate | API keys can be "sending access" only and limited to one domain |
| Internationalised addresses (SMTPUTF8) | **Not supported.** The local part must be 7-bit ASCII; IDN domains are sent as Punycode | Not documented | Not documented |
| Data retention at the provider | Sending events are kept only in our own systems (SNS doesn't store them) | 45 days by default | 30 days |

**Mailgun** was in the claim plan but isn't compared: its residency (US or EU) and pricing put it in the same place as
Postmark and Resend without anything they lack. Three providers meet the acceptance criterion.

## SMTPUTF8 (internationalised addresses)

SES doesn't support SMTPUTF8 (RFC 6531). Its API reference says the local part of a destination address "may only
contain 7-bit ASCII characters", and a non-ASCII domain must be Punycode-encoded.

Consequence for the build (requirements, "Case and Unicode in email"):

- Sign-up, resend, forgot-password and invitation forms **reject an email whose local part isn't ASCII**, with the
  message: "Use an email address with only English letters, numbers and symbols before the @."
- A Unicode domain is accepted and stored lower-cased in its **Punycode** form (`xn--…`), so it can be sent to.
  Comparison uses the stored form.
- These rules belong in the shared email schema used by T13 (#217), T14 (#218), T15 (#219) and invitations, not only
  in the SES adapter, so the same address is never accepted in one place and refused in another.

## DNS records for `jobflow@shivomsangha.com`

The owner adds these in **Cloudflare DNS**. Every record is **DNS only (grey cloud)**: a proxied record breaks mail.
The three DKIM tokens and the account-specific values are shown by SES when the identity is created; the placeholders
below mark where they go.

| # | Type | Name | Value | Purpose |
|---|---|---|---|---|
| 1 | CNAME | `<token1>._domainkey.shivomsangha.com` | `<token1>.dkim.amazonses.com` | Easy DKIM, 2048-bit |
| 2 | CNAME | `<token2>._domainkey.shivomsangha.com` | `<token2>.dkim.amazonses.com` | Easy DKIM |
| 3 | CNAME | `<token3>._domainkey.shivomsangha.com` | `<token3>.dkim.amazonses.com` | Easy DKIM |
| 4 | MX | `bounce.shivomsangha.com` | `10 feedback-smtp.ap-southeast-2.amazonses.com` | Custom MAIL FROM, so SPF aligns |
| 5 | TXT | `bounce.shivomsangha.com` | `"v=spf1 include:amazonses.com ~all"` | SPF for the MAIL FROM domain |
| 6 | TXT | `_dmarc.shivomsangha.com` | `"v=DMARC1; p=none; rua=mailto:jobflow@shivomsangha.com; adkim=r; aspf=r; fo=1"` | DMARC, monitoring only to start |

- **SPF on the root domain isn't changed.** SES's envelope sender is `bounce.shivomsangha.com`, so SPF is checked
  there (record 5). If `shivomsangha.com` already has an SPF record for other mail, leave it as it is; if it later
  needs one, it must be a single TXT record that merges every sender.
- **DMARC passes on DKIM alone** (records 1–3 sign as `shivomsangha.com`), and on SPF through the aligned MAIL FROM.
- **DMARC policy.** Start at `p=none` and read the aggregate reports for 2–4 weeks. Once every legitimate source
  passes, move to `p=quarantine`, then `p=reject`. If the domain already has a `_dmarc` record, change that one:
  there must be only one.
- **Reports and replies need an inbox.** `jobflow@shivomsangha.com` is the sender, the reply-to, the support address,
  the operator notification address and the DMARC `rua` target, so it must **receive** mail. If the domain has no
  mailbox yet, **Cloudflare Email Routing** (free) can forward it to the owner's inbox. It adds its own MX and SPF
  records at the root, and doesn't conflict with records 1–6.

## Bounce and complaint callbacks with SNS

1. **SES configuration set** per environment: `jobflow-staging` and `jobflow-production`. Each has an **SNS event
   destination** for `BOUNCE`, `COMPLAINT` and `REJECT` (optionally `DELIVERY` for metrics).
2. **SNS topic** per environment, with an **HTTPS subscription** to `https://<host>/api/webhooks/email`.
3. **Subscription confirmation is done by hand.** The handler stores nothing and never fetches the `SubscribeURL`.
   The owner confirms the subscription in the SNS console, so a forged message can't make the server fetch an
   arbitrary URL.
4. **Verification in `withWebhook`** (see the #238 review), before parsing anything else:
   - `SignatureVersion` is `2` (SHA-256), and `SigningCertURL` is `https:` with the host exactly
     `sns.ap-southeast-2.amazonaws.com` and a path ending in `.pem`. The certificate is fetched, cached, and checked
     to be issued for that host.
   - The signature is checked over SNS's canonical string with `node:crypto`.
   - `TopicArn` equals the configured `EMAIL_EVENTS_TOPIC_ARN`.
   - `Timestamp` is within 5 minutes, and `MessageId` hasn't been seen before (replay table).
5. **SES "include original headers" is off**, which keeps each message small. The 64 KiB body limit proposed for
   `withWebhook` then has a wide margin (an SNS message is at most 256 KiB).
6. A hard bounce or complaint adds the address HMAC to `email_suppressions`. A soft bounce is only logged.
7. The webhook path must stay **outside** the Cloudflare Access policy for `/operator`.

The web container then needs egress to `email.ap-southeast-2.amazonaws.com` (sending) and
`sns.ap-southeast-2.amazonaws.com` (certificates). This updates ADR 0004's egress list.

## Send-only IAM policy (one user or role per environment)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:ap-southeast-2:<account-id>:identity/shivomsangha.com",
        "arn:aws:ses:ap-southeast-2:<account-id>:configuration-set/jobflow-<env>"
      ],
      "Condition": { "StringEquals": { "ses:FromAddress": "jobflow@shivomsangha.com" } }
    }
  ]
}
```

- No other SES, SNS or IAM permission. The key can't read sending history, change identities or turn off the
  suppression list.
- The key goes in the environment's secret file (`infra/staging/env/web.env`, mode 600), never in the repository, as
  T12 (#216) sets out.
- **Staging can't email the public.** SES production access is per account and region, so staging could otherwise
  send to anyone who signs up there. Add `EMAIL_RECIPIENT_ALLOWLIST` (a list of domains or addresses), **required**
  whenever `APP_ENV` isn't `production`. The dispatcher marks any other recipient `cancelled`, without sending.

## Adapter sketch (no dependency added)

The adapter implements the `EmailTransport` port from ADR 0004 D7. The real implementation (T11, #215) adds
`@aws-sdk/client-sesv2`, pinned to the same release line as the `@aws-sdk/client-s3` already used.

```ts
// apps/web/src/server/email/ses-transport.ts (sketch)
import type { EmailTransport, OutgoingEmail } from "./transport";

export function sesTransport(config: {
  region: "ap-southeast-2";
  configurationSet: string; // jobflow-staging | jobflow-production
  from: string; // EMAIL_FROM
  replyTo: string; // EMAIL_REPLY_TO
  send: (input: SesSendEmailInput) => Promise<{ MessageId?: string }>; // SESv2Client.send(new SendEmailCommand(...))
}): EmailTransport {
  return {
    async send(message: OutgoingEmail) {
      const result = await config.send({
        FromEmailAddress: config.from,
        ReplyToAddresses: [config.replyTo],
        Destination: { ToAddresses: [message.to] }, // ASCII local part, Punycode domain
        ConfigurationSetName: config.configurationSet,
        EmailTags: [{ Name: "kind", Value: message.kind }], // no user data in tags
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
      });
      if (!result.MessageId) throw new EmailTransportError("no_message_id");
      return { providerMessageId: result.MessageId };
    },
  };
}
```

- **Errors are classified.** Throttling and 5xx errors are retryable. `MessageRejected`,
  `MailFromDomainNotVerified` and `AccountSendingPaused` aren't, and the row is marked `failed` at once. The class
  name goes in `email_outbox.last_error`, never the message text, which can contain the address.
- **Send rate.** The dispatcher sends one at a time, staying under SES's default rate (14 a second after
  production access), so no client-side rate limiter is needed at this volume.
- `MemoryTransport` and `ConsoleTransport` stay as ADR 0004 describes. Tests never call SES.

## Owner actions

1. **AWS account and budget.** Use the AWS account that holds the document buckets (or create one). Work in
   `ap-southeast-2`. Add an **AWS Budget** alert at a low amount (for example $5 a month), so a sending fault is
   noticed early.
2. **SES identity.** Create the domain identity `shivomsangha.com` with Easy DKIM (RSA 2048) and the custom MAIL FROM
   domain `bounce.shivomsangha.com` (behaviour on MX failure: "Use default MAIL FROM").
3. **DNS.** Add records 1–6 above in Cloudflare (DNS only), then wait for SES to show the domain as verified.
4. **Inbox.** Make sure `jobflow@shivomsangha.com` receives mail, for example with Cloudflare Email Routing.
5. **Production access.** Request it for `ap-southeast-2`: transactional account email only, about 1,000 a month at
   first, with bounces and complaints suppressed automatically, and recipients only those who sign up or are
   invited.
6. **Per environment** (staging first):
   - a configuration set and an SNS topic with an HTTPS subscription to `/api/webhooks/email`, confirmed in the
     console;
   - a send-only IAM user with the policy above;
   - its keys put in the host's secret file.

   This is T12 (#216).
7. **Billing.** Pay-as-you-go: about $0.10 per 1,000 emails, roughly cents a month at pilot volume. New AWS accounts
   also get free-tier credits.

## What this changes in the plan

- **ADR 0004 D7:** the "real adapter" becomes the SES adapter. The external dependencies list gains
  `email.ap-southeast-2.amazonaws.com` and `sns.ap-southeast-2.amazonaws.com`, and the config gains
  `EMAIL_EVENTS_TOPIC_ARN` and `EMAIL_RECIPIENT_ALLOWLIST`.
- **T11 (#215):** SES adapter, SNS verification in `withWebhook`, error classes, and the recipient allowlist.
- **T12 (#216):** records 1–6, the configuration sets, the topics, the IAM policy and the secrets.
- **T13–T15 and invitations:** the ASCII local-part and Punycode rule in the shared email schema.

## Sources

Checked on 3 November 2026:

- [Amazon SES pricing](https://aws.amazon.com/en/ses/pricing/): $0.10 per 1,000 (à la carte); the plans; dedicated
  IP; attachments; VDM.
- [Amazon SES v2 `Destination`, AWS SDK reference](https://docs.aws.amazon.com/sdk-for-ruby/v3/api/Aws/SESV2/Types/Destination.html):
  "Amazon SES does not support the SMTPUTF8 extension".
- [Amazon SES events to Amazon SNS](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)
  and [SES bounce and complaint notifications](https://aws.amazon.com/blogs/messaging-and-targeting/amazon-ses-set-up-notifications-for-bounces-and-complaints).
- [Postmark pricing](https://postmarkapp.com/pricing.txt): plans, overage, dedicated IP and retention.
- [Postmark webhooks guide (Hookdeck)](https://hookdeck.com/webhooks/platforms/guide-to-postmark-webhooks-features-and-best-practices):
  no HMAC signature verification.
- [Postmark EU alternatives (Nuntly)](https://nuntly.com/alternatives/postmark-eu): US-only storage. This is a
  competitor's claim and isn't independently confirmed.
- [Resend pricing](https://www.resend.com/pricing.md): free 3,000 a month or 100 a day; Pro $20 for 50,000 and $35 for
  100,000; dedicated IP.
- [Resend regions](https://www.resend.com/docs/dashboard/domains/regions.md): four sending regions; account data
  stored in the US.
- [Resend webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests): Svix headers.

**Not verified:** SMTPUTF8 support at Postmark and Resend (neither documents it); current SES production-access
turnaround time; the existing DNS for `shivomsangha.com`, because DNS lookups can't be made from the build
environment, so the owner must check for an existing SPF or DMARC record before adding records 5–6.
