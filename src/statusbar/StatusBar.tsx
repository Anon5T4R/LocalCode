import { memo } from "react";
import { basename } from "../lib/path";
import { useCursor } from "../lib/cursor";

interface StatusBarProps {
  language?: string;
  filePath?: string | null;
  gitBranch?: string;
}

export const StatusBar = memo(function StatusBar({
  language = "Plain Text",
  filePath,
  gitBranch,
}: StatusBarProps) {
  // Subscribed here (not passed from App) so caret moves don't re-render App.
  const { line, col: column } = useCursor();
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {gitBranch && (
          <span className="status-item status-branch">
            <span className="codicon codicon-git-branch" /> {gitBranch}
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
        <span className="status-item">Ln {line}, Col {column}</span>
      </div>
    </div>
  );
});
