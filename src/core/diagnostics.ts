export type WorkbenchDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  filePath?: string;
  relatedFilePath?: string;
  agentName?: string;
  count?: number;
  fieldPath?: string;
  hint?: string;
};
