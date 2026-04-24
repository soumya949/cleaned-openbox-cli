declare module 'cli-table3' {
  type TableOptions = {
    head?: Array<string>;
    colWidths?: Array<number>;
    wordWrap?: boolean;
  };

  export default class Table {
    constructor(options?: TableOptions);
    push(...rows: Array<Array<string | number>>): number;
    toString(): string;
  }
}
