/**
 * The server's verdict on one field — a name already taken, a path it refused — as an updater for
 * `form.setFieldMeta`. It sits in the field's `onServer` slot, so it is drawn like any other error
 * and holds back Submit; pass `undefined` from the field's `onChange` listener to clear it.
 */
export const serverError =
  (message: string | undefined) =>
  <M extends { errorMap: object }>(meta: M): M => ({
    ...meta,
    errorMap: { ...meta.errorMap, onServer: message },
  });

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
