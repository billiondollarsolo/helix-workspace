/** A command line the CLI cannot run as written; the runner prints usage with it. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
