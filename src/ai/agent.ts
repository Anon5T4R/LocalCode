import { readFile, writeFile, listDir } from "../lib/fs";
import { invoke } from "@tauri-apps/api/core";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  required: string[];
}

export interface ToolResult {
  tool: string;
  success: boolean;
  output: string;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "read_file",
    description: "Lê o conteúdo de um arquivo",
    parameters: {
      path: { type: "string", description: "Caminho absoluto do arquivo" },
    },
    required: ["path"],
  },
  {
    name: "create_file",
    description: "Cria um novo arquivo com conteúdo",
    parameters: {
      path: { type: "string", description: "Caminho absoluto do arquivo" },
      content: { type: "string", description: "Conteúdo do arquivo" },
    },
    required: ["path", "content"],
  },
  {
    name: "edit_file",
    description: "Edita um arquivo substituindo um trecho por outro",
    parameters: {
      path: { type: "string", description: "Caminho absoluto do arquivo" },
      old_string: { type: "string", description: "Texto a ser substituído (deve existir no arquivo)" },
      new_string: { type: "string", description: "Novo texto" },
    },
    required: ["path", "old_string", "new_string"],
  },
  {
    name: "delete_file",
    description: "Exclui um arquivo ou diretório",
    parameters: {
      path: { type: "string", description: "Caminho absoluto" },
    },
    required: ["path"],
  },
  {
    name: "rename_file",
    description: "Renomeia ou move um arquivo/diretório",
    parameters: {
      old_path: { type: "string", description: "Caminho atual" },
      new_path: { type: "string", description: "Novo caminho" },
    },
    required: ["old_path", "new_path"],
  },
  {
    name: "list_dir",
    description: "Lista o conteúdo de um diretório",
    parameters: {
      path: { type: "string", description: "Caminho do diretório" },
    },
    required: ["path"],
  },
  {
    name: "search_files",
    description: "Busca texto em arquivos (grep)",
    parameters: {
      root: { type: "string", description: "Diretório raiz da busca" },
      query: { type: "string", description: "Texto a procurar" },
    },
    required: ["root", "query"],
  },
  {
    name: "execute_command",
    description: "EXECUTA UM COMANDO NO TERMINAL. Requer confirmação explícita do usuário.",
    parameters: {
      command: { type: "string", description: "Comando a ser executado" },
      description: { type: "string", description: "Explicação do que o comando faz" },
    },
    required: ["command", "description"],
  },
];

export const AGENT_SYSTEM_PROMPT = `Você é um assistente de programação integrado ao LocalCode, especializado em Rust.

Você tem acesso a ferramentas que podem ler, criar, editar e excluir arquivos, além de executar comandos no terminal.

PREFERÊNCIA POR RUST:
- SEMPRE prefira Rust para qualquer nova implementação, a menos que o usuário peça explicitamente outra linguagem
- Use cargo new para criar novos projetos Rust
- Siga as convenções da comunidade Rust: snake_case, Result<T, E> em vez de exceptions, Option<T> em vez de null
- Prefira bibliotecas da std Rust e crates populares e bem mantidas
- Inclua testes de unidade em todos os módulos Rust (#[cfg(test)] mod tests)
- Use rustfmt e clippy para manter o código limpo
- Para projetos Rust, use a estrutura de diretórios padrão do cargo

REGRAS IMPORTANTES:
1. Sempre leia o arquivo ANTES de editá-lo, para entender o contexto
2. Para criar múltiplos arquivos, faça um de cada vez
3. Para comandos de terminal, SEMPRE explique exatamente o que o comando faz
4. Prefira editar arquivos existentes em vez de recriá-los do zero
5. Use search_files para encontrar código relevante antes de fazer alterações
6. Após criar ou editar código Rust, execute cargo check para validar

Ferramentas disponíveis:
${AGENT_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

Para usar uma ferramenta, responda com um objeto JSON na seguinte estrutura:
{"tool": "nome_da_ferramenta", "args": { ... }}

Você pode chamar várias ferramentas em sequência, uma por resposta.
Se o usuário pedir algo que não requer ferramentas, responda normalmente.`;

export function normalizeArgs(args: Record<string, any>, tool: string): Record<string, any> {
  // Models often use file_path / file_content instead of path / content
  const aliases: Record<string, Record<string, string>> = {
    create_file: { file_path: "path", file_content: "content" },
    read_file: { file_path: "path" },
    edit_file: { file_path: "path" },
    delete_file: { file_path: "path" },
    rename_file: { file_path: "old_path" },
  };
  const normalized = { ...args };
  const map = aliases[tool] || {};
  for (const [from, to] of Object.entries(map)) {
    if (from in normalized && !(to in normalized)) {
      normalized[to] = normalized[from];
      delete normalized[from];
    }
  }
  return normalized;
}

export function parseToolCall(text: string): { tool: string; args: Record<string, any> } | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed.tool && parsed.args) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function executeTool(
  tool: string,
  args: Record<string, any>,
  workspaceRoot?: string
): Promise<ToolResult> {

  try {
    switch (tool) {
      case "read_file": {
        const content = await readFile(args.path);
        return { tool, success: true, output: content };
      }
      case "create_file": {
        await writeFile(args.path, args.content);
        return { tool, success: true, output: `Arquivo criado: ${args.path}` };
      }
      case "edit_file": {
        const content = await readFile(args.path);
        if (!content.includes(args.old_string)) {
          return { tool, success: false, output: `Texto não encontrado em ${args.path}` };
        }
        const newContent = content.replace(args.old_string, args.new_string);
        await writeFile(args.path, newContent);
        return { tool, success: true, output: `Arquivo editado: ${args.path}` };
      }
      case "delete_file": {
        await invoke("delete_file", { path: args.path });
        return { tool, success: true, output: `Excluído: ${args.path}` };
      }
      case "rename_file": {
        await invoke("rename_file", { oldPath: args.old_path, newPath: args.new_path });
        return { tool, success: true, output: `Movido: ${args.old_path} → ${args.new_path}` };
      }
      case "list_dir": {
        const entries = await listDir(args.path);
        const lines = entries.map((e: any) => `${e.is_dir ? "📁" : "📄"} ${e.name}`);
        return { tool, success: true, output: lines.join("\n") };
      }
      case "search_files": {
        const results: any[] = await invoke("search_files", {
          root: args.root || workspaceRoot || args.path,
          query: args.query,
        });
        const grouped: Record<string, string[]> = {};
        for (const r of results) {
          if (!grouped[r.path]) grouped[r.path] = [];
          grouped[r.path].push(`  linha ${r.line}: ${r.line_content}`);
        }
        const lines = Object.entries(grouped).map(([path, matches]) =>
          `${path}\n${matches.join("\n")}`
        );
        return { tool, success: true, output: lines.join("\n\n") || "Nenhum resultado" };
      }
      case "execute_command": {
        // This is handled specially with confirmation
        return { tool, success: false, output: "Comandos de terminal requerem confirmação manual" };
      }
      default:
        return { tool, success: false, output: `Ferramenta desconhecida: ${tool}` };
    }
  } catch (e: any) {
    return { tool, success: false, output: `Erro: ${e.message || e}` };
  }
}
