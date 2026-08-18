import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OrderItem {
  product_id: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  total: number;
  created_at: string;
}

export interface OrderStore {
  getCurrentOrder(): Promise<Order | null>;
  saveOrder(items: OrderItem[]): Promise<Order>;
  removeCurrentOrder(): Promise<Order | null>;
}

interface OrderDatabase {
  current_order: Order | null;
}

const EMPTY_DATABASE: OrderDatabase = { current_order: null };

export class JsonOrderStore implements OrderStore {
  readonly filePath: string;
  private operation = Promise.resolve();

  constructor(filePath = 'data/orders.json') {
    this.filePath = filePath;
  }

  async getCurrentOrder(): Promise<Order | null> {
    await this.operation;
    return (await this.readDatabase()).current_order;
  }

  async saveOrder(items: OrderItem[]): Promise<Order> {
    return this.exclusive(async () => {
      const order: Order = {
        id: randomUUID(),
        items: structuredClone(items),
        total: items.reduce((sum, item) => sum + item.quantity * item.price, 0),
        created_at: new Date().toISOString(),
      };

      await this.writeDatabase({ current_order: order });
      return order;
    });
  }

  async removeCurrentOrder(): Promise<Order | null> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const removedOrder = database.current_order;

      if (removedOrder) {
        await this.writeDatabase(EMPTY_DATABASE);
      }

      return removedOrder;
    });
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readDatabase(): Promise<OrderDatabase> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      return JSON.parse(contents) as OrderDatabase;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return EMPTY_DATABASE;
      }
      throw error;
    }
  }

  private async writeDatabase(database: OrderDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(database, null, 2)}\n`,
      'utf8',
    );
    await rename(temporaryPath, this.filePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
