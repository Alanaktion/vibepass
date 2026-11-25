/** Thrown by scaffold stubs that have a typed signature but no implementation yet. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = 'NotImplementedError';
  }
}
