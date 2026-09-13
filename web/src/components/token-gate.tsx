import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden /> Token required
          </CardTitle>
          <CardDescription>
            This server was started with <code>RAGDOWN_TOKEN</code>. Enter it to read the index.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="password"
              aria-label="Token"
              placeholder="Bearer token"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
