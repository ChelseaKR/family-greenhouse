import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { TFunction } from 'i18next';

// The sign-in form's validation, in its own module so LoginPage can load it
// on demand. zod plus its resolver is ~36 kB compressed, and as a static
// import of LoginPage it sat on the /login critical path: nothing on the page
// painted until it had downloaded. Validation first runs on submit, so the
// page paints without it and fetches it once a field is focused.
//
// Built per-call from the active locale so validation messages are
// translated (zod resolves the message at schema-construction time, so the
// schema has to be rebuilt when the language changes — not defined at module
// load when no `t` exists yet).
export const makeLoginSchema = (t: TFunction) =>
  z.object({
    email: z.string().email(t('auth.invalidEmail')),
    password: z.string().min(1, t('auth.passwordRequired')),
  });

export type LoginFormData = z.infer<ReturnType<typeof makeLoginSchema>>;

export const makeLoginResolver = (t: TFunction) => zodResolver(makeLoginSchema(t));
