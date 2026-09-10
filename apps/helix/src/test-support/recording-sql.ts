import type postgres from "postgres";

export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Ordered results or a test's domain responder; records transaction and parameter calls. */
export function createRecordingSql(
  responses: readonly unknown[] | ((query: RecordedQuery) => unknown) = [],
  separator = "?",
) {
  const calls: RecordedQuery[] = [];
  const arrays: (readonly unknown[])[] = [];
  const jsonValues: unknown[] = [];
  const beginOptions: string[] = [];
  let beginCalls = 0;
  let index = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join(separator), values };
    calls.push(query);
    return Promise.resolve(
      typeof responses === "function" ? responses(query) : (responses[index++] ?? []),
    );
  };
  const sql = Object.assign(tag, {
    unsafe: (text: string) => text,
    json: (value: unknown) => {
      jsonValues.push(value);
      return value;
    },
    array: (value: readonly unknown[]) => {
      arrays.push(value);
      return value;
    },
    begin: async <T>(
      options: string | ((tx: postgres.TransactionSql) => T | Promise<T>),
      callback?: (tx: postgres.TransactionSql) => T | Promise<T>,
    ) => {
      beginCalls += 1;
      if (typeof options === "string") beginOptions.push(options);
      const execute = typeof options === "function" ? options : callback;
      if (execute === undefined) throw new Error("Missing transaction callback.");
      return execute(sql as unknown as postgres.TransactionSql);
    },
  }) as unknown as postgres.Sql;
  return {
    sql,
    calls,
    arrays,
    jsonValues,
    beginOptions,
    get beginCalls() {
      return beginCalls;
    },
    get queries() {
      return calls.map(({ text }) => text);
    },
    get values() {
      return calls.map(({ values }) => values);
    },
  };
}
