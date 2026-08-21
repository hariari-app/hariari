import fs from 'node:fs';
import path from 'node:path';
import type { TaskOutputEvent } from '../shared/runtime/runtime-interface';

/** Runtime-owned durable scrollback, intentionally addressed only through Task identity. */
export class TaskOutputLog {
  private readonly directory: string;

  constructor(runtimeDirectory: string) {
    this.directory = path.join(runtimeDirectory, 'tasks', 'output');
  }

  append(event: TaskOutputEvent): void {
    const taskDirectory = path.join(this.directory, event.taskId);
    fs.mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(taskDirectory, `${event.sequence}.json`);
    const temporary = path.join(taskDirectory, `.${event.sequence}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(event), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, destination);
  }

  replay(taskId: string): readonly TaskOutputEvent[] {
    const taskDirectory = path.join(this.directory, taskId);
    if (!fs.existsSync(taskDirectory)) return [];
    return fs
      .readdirSync(taskDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(taskDirectory, name), 'utf8')) as TaskOutputEvent)
      .sort((left, right) => left.sequence - right.sequence);
  }
}
