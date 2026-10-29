---
name: Password Reset
subject: "Reset your {{org.name}} Outpost password"
from: "{{org.name}} <{{org.email}}>"
note: Fixed text by design (outpost#206). Not listed on Settings > Templates and not overridable. Never interpolate member.name.
---

Hi,

We received a request to reset the password for your **{{org.name}}** Outpost account ({{member.email}}).

[Reset your password]({{reset.url}})

This link expires in {{reset.expiresIn}} and can be used once.

If you did not request this, you can ignore this email. Your password will not change.
