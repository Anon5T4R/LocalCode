import { describe, expect, it } from "vitest";
import { cursorStore } from "../cursor";

// O cursorStore existe justamente pra digitar não re-renderizar a árvore toda.
// As duas regras abaixo são o contrato do useSyncExternalStore: get estável
// entre notificações, e nada de notificar à toa.

describe("cursorStore", () => {
  it("get_devolve_a_mesma_referencia_enquanto_nada_muda", () => {
    // Se get() criasse um objeto novo a cada chamada, o useSyncExternalStore
    // veria snapshot sempre diferente e entraria em loop infinito de render.
    cursorStore.set(3, 7);
    expect(cursorStore.get()).toBe(cursorStore.get());
  });

  it("set_com_a_mesma_posicao_nao_notifica", () => {
    // Toda tecla que não move o caret (setas presas no fim da linha, seleção
    // repetida) chamaria os listeners e derrubaria o ganho do store.
    cursorStore.set(1, 1);
    let notificacoes = 0;
    const cancelar = cursorStore.subscribe(() => notificacoes++);
    cursorStore.set(1, 1);
    expect(notificacoes).toBe(0);
    cursorStore.set(1, 2);
    expect(notificacoes).toBe(1);
    cancelar();
  });

  it("subscribe_devolve_cancelamento_que_de_fato_remove_o_listener", () => {
    // Componente desmontado que continua recebendo notificação vira setState
    // em árvore morta.
    cursorStore.set(1, 1);
    let notificacoes = 0;
    const cancelar = cursorStore.subscribe(() => notificacoes++);
    cancelar();
    cursorStore.set(5, 5);
    expect(notificacoes).toBe(0);
  });
});
