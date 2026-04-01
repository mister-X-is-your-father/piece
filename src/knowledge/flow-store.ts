import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import type { Flow, FlowInsert, FlowStep, FlowStepInsert } from "./schemas.js";

export class FlowStore {
  private db: Database.Database;

  constructor(scribePath: string) {
    this.db = getKnowledgeDB(scribePath);
  }

  insertFlow(input: FlowInsert): Flow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO flows (id, name, description, trigger_description)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, input.name, input.description, input.trigger_description);
    return this.getFlow(id)!;
  }

  getFlow(id: string): Flow | null {
    return (
      (this.db
        .prepare("SELECT * FROM flows WHERE id = ?")
        .get(id) as Flow | undefined) ?? null
    );
  }

  getFlowWithSteps(id: string): (Flow & { steps: FlowStep[] }) | null {
    const flow = this.getFlow(id);
    if (!flow) return null;
    const steps = this.getFlowSteps(id);
    return { ...flow, steps };
  }

  listFlows(): Flow[] {
    return this.db
      .prepare("SELECT * FROM flows ORDER BY created_at DESC")
      .all() as Flow[];
  }

  addFlowStep(input: FlowStepInsert): FlowStep {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO flow_steps (id, flow_id, step_order, specialist, description, file_path, start_line, end_line, code_snippet, node_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.flow_id,
        input.step_order,
        input.specialist ?? null,
        input.description,
        input.file_path ?? null,
        input.start_line ?? null,
        input.end_line ?? null,
        input.code_snippet ?? null,
        input.node_id ?? null
      );
    return this.db
      .prepare("SELECT * FROM flow_steps WHERE id = ?")
      .get(id) as FlowStep;
  }

  getFlowSteps(flowId: string): FlowStep[] {
    return this.db
      .prepare(
        "SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_order ASC"
      )
      .all(flowId) as FlowStep[];
  }

  findFlowsBySpecialist(specialist: string): Flow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT f.* FROM flows f
         JOIN flow_steps fs ON fs.flow_id = f.id
         WHERE fs.specialist = ?
         ORDER BY f.created_at DESC`
      )
      .all(specialist) as Flow[];
  }

  getFlowCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM flows")
      .get() as { count: number };
    return row.count;
  }
}
