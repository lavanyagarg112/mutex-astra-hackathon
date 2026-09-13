export type ProcessState = { projectId: string; userId: string; name: string; status: string; port?: number; url?: string; updatedAt: string };

export class RuntimeState {
  private readonly processes = new Map<string, ProcessState>();

  setProcess(state: Omit<ProcessState, "updatedAt">) {
    const value = { ...state, updatedAt: new Date().toISOString() };
    this.processes.set(`${state.projectId}:${state.userId}:${state.name}`, value);
    return value;
  }

  projectProcesses(projectId: string) {
    return [...this.processes.values()].filter((process) => process.projectId === projectId);
  }
}

