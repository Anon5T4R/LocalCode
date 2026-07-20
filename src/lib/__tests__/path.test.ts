import { describe, expect, it } from "vitest";
import { basename, dirname, joinPath } from "../path";

// path.ts é neutro de plataforma por construção: ele mesmo normaliza "\" para
// "/" antes de qualquer coisa. Por isso os literais com barra invertida abaixo
// são seguros no job Ubuntu do CI — nada aqui chama o `path` do Node.

describe("basename", () => {
  it("barra_final_nao_vira_nome_vazio", () => {
    // O explorer passa caminho de pasta com barra no fim; sem o filter(Boolean)
    // o split devolveria "" e a aba/status bar ficaria sem título.
    expect(basename("/home/user/projeto/")).toBe("projeto");
  });

  it("caminho_sem_separador_e_o_proprio_nome", () => {
    expect(basename("arquivo.ts")).toBe("arquivo.ts");
  });

  it("raiz_nao_tem_nome_proprio_e_devolve_o_caminho", () => {
    // Sem o fallback `|| path` isso seria "" (undefined do pop), e o título
    // do arquivo aberto na raiz sumiria da UI.
    expect(basename("/")).toBe("/");
  });

  it("separador_windows_conta_como_separador", () => {
    // Caso especificamente Windows: o caminho chega do backend com "\".
    expect(basename("C:\\Dev\\Local\\arquivo.ts")).toBe("arquivo.ts");
  });

  it("nome_com_espaco_e_acento_nao_e_recortado", () => {
    expect(basename("/tmp/relatório final.md")).toBe("relatório final.md");
  });
});

describe("dirname", () => {
  it("absoluto_unix_mantem_a_barra_inicial", () => {
    // Sem o `startsWith("/")` o resultado seria relativo ("home/user") e toda
    // operação de arquivo derivada do pai (renomear, criar, deletar) miraria
    // no cwd errado.
    expect(dirname("/home/user/a.txt")).toBe("/home/user");
  });

  it("arquivo_na_raiz_unix_tem_a_raiz_como_pai", () => {
    expect(dirname("/a.txt")).toBe("/");
  });

  it("caminho_relativo_sem_pasta_tem_pai_ponto", () => {
    // O findUp do debug para quando o pai é "."; se isso virasse "" ele
    // pararia por outra condição (ou não pararia).
    expect(dirname("a.txt")).toBe(".");
  });

  it("barra_final_nao_conta_como_nivel_extra", () => {
    // "pasta/" e "pasta" têm que ter o mesmo pai; sem o filter(Boolean) o
    // primeiro perderia só a string vazia e devolveria a própria pasta.
    expect(dirname("/home/user/")).toBe("/home");
    expect(dirname("/home/user")).toBe("/home");
  });

  it("separador_windows_e_normalizado_para_barra", () => {
    // Caso especificamente Windows.
    expect(dirname("C:\\Dev\\Local\\arquivo.ts")).toBe("C:/Dev/Local");
  });
});

describe("joinPath", () => {
  it("nao_duplica_barra_quando_as_partes_ja_tem", () => {
    // dirname() devolve sem barra final, mas o nome digitado pelo usuário no
    // explorer pode vir com barra; sem o trim o caminho sairia "a//b" e o
    // backend não acharia o arquivo.
    expect(joinPath("/home/user/", "/docs/")).toBe("/home/user/docs");
  });

  it("parte_vazia_e_descartada", () => {
    // Campo de criar arquivo em branco no meio não pode gerar "a//b".
    expect(joinPath("a", "", "b")).toBe("a/b");
  });

  it("separador_windows_vira_barra_no_resultado", () => {
    // Caso especificamente Windows: mistura de "\" da raiz com "/" do join.
    expect(joinPath("C:\\Dev\\Local", "src", "lib")).toBe("C:/Dev/Local/src/lib");
  });

  it("uma_parte_so_ainda_perde_a_barra_final", () => {
    expect(joinPath("/home/user/")).toBe("/home/user");
  });

  /**
   * O bug que este arquivo achou. O trim da parte 0 transforma "/" em "" e o
   * `filter(Boolean)` descartava — o caminho saía RELATIVO.
   *
   * Alcançável pela UI, não teórico: renomear um arquivo na raiz faz
   * `joinPath(dirname("/a.txt"), novoNome)`, e `dirname` devolve "/". O
   * arquivo ia parar no cwd do processo em vez da raiz, sem erro nenhum.
   * Só morde no Linux — no Windows a raiz é "C:/", que sobrevive ao trim.
   */
  it("raiz_unix_sozinha_nao_some_e_o_caminho_segue_absoluto", () => {
    expect(joinPath("/", "novo.txt")).toBe("/novo.txt");
    expect(joinPath("/", "sub", "a.txt")).toBe("/sub/a.txt");
  });

  it("parte_zero_vazia_de_verdade_nao_inventa_raiz", () => {
    // O oposto do caso acima: "" não pode virar "/" só porque também é falsy
    // depois do trim, senão caminho relativo viraria absoluto.
    expect(joinPath("", "a.txt")).toBe("a.txt");
  });
});
