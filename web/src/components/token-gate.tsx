import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAppForm } from "@/components/app-form";
import { KeyRound } from "@/components/app-icons";
import { CardLayout } from "@/components/card-layout";
import { PasswordField } from "@/components/password-field";
import { setToken, useNeedsAuth } from "@/lib/auth";

/**
 * The app, until any request comes back 401 — then a form for the server's token. Submitting
 * stores it and refetches everything, so the page that asked is the page that comes back.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const needsAuth = useNeedsAuth();
  const queryClient = useQueryClient();
  const form = useAppForm({
    defaultValues: { token: "" },
    onSubmit: ({ value }) => {
      setToken(value.token.trim());
      form.reset();
      void queryClient.invalidateQueries();
    },
  });

  if (!needsAuth) return children;

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        className="w-full max-w-sm"
      >
        <CardLayout
          icon={<KeyRound aria-hidden />}
          title="Token required"
          description={
            <>
              This server was started with <code>RAGDOWN_TOKEN</code>. Enter it to read the index.
            </>
          }
          content={
            <PasswordField
              form={form}
              name="token"
              label="Token"
              placeholder="Bearer token"
              autoComplete="current-password"
              autoFocus
              showLabel="Show token"
              hideLabel="Hide token"
              validators={{
                onChange: ({ value }) => (value.trim() ? undefined : "Enter the token."),
              }}
            />
          }
          footerActions={
            <form.AppForm>
              <form.Subscribe selector={(state) => !state.values.token.trim()}>
                {(empty) => (
                  <form.SubmitButton pendingLabel="Unlocking…" disabled={empty}>
                    Unlock
                  </form.SubmitButton>
                )}
              </form.Subscribe>
            </form.AppForm>
          }
        />
      </form>
    </div>
  );
}
