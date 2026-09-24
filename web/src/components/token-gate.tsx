import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { KeyRound } from "@/components/app-icons";
import { CardLayout } from "@/components/card-layout";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { setToken, useNeedsAuth } from "@/lib/auth";

/**
 * The app, until any request comes back 401 — then a form for the server's token. Submitting
 * stores it and refetches everything, so the page that asked is the page that comes back.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const needsAuth = useNeedsAuth();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");

  if (!needsAuth) return children;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    setToken(token);
    setValue("");
    void queryClient.invalidateQueries();
  };

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <CardLayout
          icon={<KeyRound aria-hidden />}
          title="Token required"
          description={
            <>
              This server was started with <code>RAGDOWN_TOKEN</code>. Enter it to read the index.
            </>
          }
          content={
            <FormField
              label="Token"
              control={
                <PasswordInput
                  placeholder="Bearer token"
                  autoComplete="current-password"
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  showLabel="Show token"
                  hideLabel="Hide token"
                />
              }
            />
          }
          footerActions={
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          }
        />
      </form>
    </div>
  );
}
