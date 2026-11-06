/** Serializes admitted market writes so a retired write cannot overwrite its successor. */
export class PublicationFence {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly continuous: () => boolean) {}
  invalidate(): void { this.generation++; }
  run(action: (current: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.generation;
    const current = () => generation === this.generation && this.continuous() && generation === this.generation;
    const result = this.tail.then(async () => { if (current()) await action(current); });
    this.tail = result.catch(() => undefined);
    return result;
  }
  idle(): Promise<void> { return this.tail; }
}
