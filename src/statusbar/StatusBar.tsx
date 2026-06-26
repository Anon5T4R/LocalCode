import { memo } from "react";
import { basename } from "../lib/path";

interface StatusBarProps {
  language?: string;
  line?: number;
  column?: number;
  filePath?: string | null;
  gitBranch?: string;
  encoding?: string;
  indent?: string;
}

export const StatusBar = memo(function StatusBar({
  language = "Plain Text",
  line = 1,
  column = 1,
  filePath,
  gitBranch,
  encoding = "UTF-8",
  indent = "Espaços: 2",
}: StatusBarProps) {
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {gitBranch && (
          <span className="status-item status-branch">
            ⎇ {gitBranch}
          </span>
        )}
        {filePath && (
          <span className="status-item status-path" title={filePath}>
            {basename(filePath)}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        <span className="status-item">{language}</span>
        <span className="status-item">{indent}</span>
        <span className="status-item">{encoding}</span>
        <span className="status-item">Ln {line}, Col {column}</span>
      </div>
    </div>
  );
});
