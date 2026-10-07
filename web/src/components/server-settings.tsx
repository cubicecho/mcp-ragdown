import { NumberField, SelectField, SwitchField, useAppForm } from "@/components/app-form";
import { DialogLayout } from "@/components/dialog-layout";
import { Section } from "@/components/section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { useToast } from "@/components/ui/toast";
import type { Status } from "@/lib/api";
import { hookValueError } from "@/lib/folders";
import { errorMessage } from "@/lib/form-errors";
import { useUpdateSettings } from "@/lib/queries";
import { defaultMinScore, settingsForm, settingsPatch } from "@/lib/settings";

const countError = (value: number | null) =>
  value === null || (Number.isInteger(value) && value >= 0)
    ? undefined
    : "A whole number, 0 or more.";

/**
 * The server-wide settings as one form. What is saved wins over the environment variable of the
 * same setting and applies at once; a number left empty goes back to the variable.
 */
export function EditServerSettings({
  settings,
  onClose,
}: {
  settings: Status["settings"];
  onClose: () => void;
}) {
  const update = useUpdateSettings();
  const toast = useToast();
  const form = useAppForm({
    defaultValues: settingsForm(settings),
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync(settingsPatch(settings, value));
        toast(
          value.embedder === settings.embedder
            ? "Saved the server settings"
            : `Saved. Rebuilding the index with ${value.embedder}`,
          "positive",
        );
        onClose();
      } catch (error) {
        toast(`Could not save the server settings: ${errorMessage(error)}`);
      }
    },
  });
  const changed = () => Object.keys(settingsPatch(settings, form.state.values)).length > 0;
  const env = settings.env;

  return (
    <DialogLayout
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit server settings"
      description={
        <>
          Kept in <Code>.ragdown-server.json</Code> in the docs directory. A value saved here wins
          over its environment variable.
        </>
      }
      hasUnsavedChanges={changed}
      contentSlot={
        <form
          id="edit-server-settings"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <SelectField
            form={form}
            name="embedder"
            label="Embedder"
            description={`The environment says ${env.embedder}.`}
            options={Object.keys(settings.embedders).map((name) => ({ label: name, value: name }))}
          />
          <form.Subscribe selector={(state) => state.values.embedder}>
            {(embedder) =>
              embedder === settings.embedder ? null : (
                <Alert
                  variant="warning"
                  title="Saving rebuilds the whole index"
                  description="Every note is embedded again with the new model, which is downloaded first if it is not on the server. Search answers from what is indexed so far until it is done."
                />
              )
            }
          </form.Subscribe>
          <SwitchField
            form={form}
            name="watch"
            label="Watch for changes"
            description="Off, the index syncs at start and on ragdown_reindex only."
          />
          <Section
            title="Search defaults"
            level={3}
            description={
              <>
                What <Code>ragdown_context</Code> injects before each prompt. Left empty, a value is
                the environment's, shown in the field.
              </>
            }
            contentSlot={
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  form={form}
                  name="top_k"
                  label="Sections per prompt"
                  min={0}
                  step={1}
                  placeholder={String(env.hook.top_k)}
                  validators={{ onChange: ({ value }) => hookValueError("top_k", value) }}
                />
                <NumberField
                  form={form}
                  name="max_chars"
                  label="Characters per prompt"
                  min={0}
                  step={500}
                  placeholder={String(env.hook.max_chars)}
                  validators={{ onChange: ({ value }) => hookValueError("max_chars", value) }}
                />
                <form.Subscribe selector={(state) => state.values.embedder}>
                  {(embedder) => {
                    const unrelated = settings.embedders[embedder]?.unrelated_score;
                    return (
                      <NumberField
                        form={form}
                        name="min_score"
                        label="Minimum score"
                        description={
                          typeof unrelated === "number"
                            ? `Cosine similarity, on the embedder's own scale. Keep it above ${unrelated}, which an unrelated prompt can score with ${embedder}.`
                            : "Cosine similarity, on the embedder's own scale."
                        }
                        step={0.05}
                        placeholder={String(defaultMinScore(settings, embedder))}
                      />
                    );
                  }}
                </form.Subscribe>
                <NumberField
                  form={form}
                  name="min_ratio"
                  label="Share of the best hit"
                  description="The least a hit may score against the best one; 0 turns it off."
                  min={0}
                  max={1}
                  step={0.05}
                  placeholder={String(env.hook.min_ratio)}
                  validators={{ onChange: ({ value }) => hookValueError("min_ratio", value) }}
                />
                <NumberField
                  form={form}
                  name="text_limit"
                  label="Characters per hit"
                  description="Longer sections are clipped in search results."
                  min={0}
                  step={500}
                  placeholder={String(env.text_limit)}
                  validators={{ onChange: ({ value }) => countError(value) }}
                />
              </div>
            }
          />
        </form>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.Subscribe
              selector={(state) => Object.keys(settingsPatch(settings, state.values)).length === 0}
            >
              {(unchanged) => (
                <form.SubmitButton
                  form="edit-server-settings"
                  pendingLabel="Saving…"
                  disabled={unchanged}
                  content="Save"
                />
              )}
            </form.Subscribe>
          </form.AppForm>
        </>
      )}
    />
  );
}
