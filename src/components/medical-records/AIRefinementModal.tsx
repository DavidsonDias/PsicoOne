import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Merge, ArrowRight } from "lucide-react";

interface AIRefinementModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalText: string;
  refinedText: string;
  mode: "refine" | "organize" | "local";
  onReplace: () => void;
  onMerge: () => void;
}

export function AIRefinementModal({
  open,
  onOpenChange,
  originalText,
  refinedText,
  mode,
  onReplace,
  onMerge,
}: AIRefinementModalProps) {
  const [tab, setTab] = useState("comparison");
  const title = mode === "local" ? "Formatação local — sem IA" : mode === "organize" ? "Organização Clínica" : "Refinamento com IA";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            <Badge variant="secondary" className="text-xs">
              {mode === "local" ? "Sem créditos" : mode === "organize" ? "Formato clínico" : "Texto refinado"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {mode === "local" && <p className="text-sm text-muted-foreground">Ajusta apenas espaços e linhas. Não corrige gramática, não resume e não envia o texto para um serviço de IA. Confira antes de aplicar.</p>}

        <Tabs value={tab} onValueChange={setTab} className="flex-1 min-h-0">
          <TabsList className="w-full">
            <TabsTrigger value="comparison" className="flex-1">Comparação</TabsTrigger>
            <TabsTrigger value="original" className="flex-1">Original</TabsTrigger>
            <TabsTrigger value="refined" className="flex-1">Resultado</TabsTrigger>
          </TabsList>

          <TabsContent value="comparison" className="mt-4 flex-1 min-h-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Original</p>
                <ScrollArea className="h-[300px] border rounded-lg p-3">
                  <p className="text-sm whitespace-pre-wrap">{originalText}</p>
                </ScrollArea>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground">{mode === "local" ? "Resultado local" : "Resultado IA"}</p>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </div>
                <ScrollArea className="h-[300px] border border-primary/30 rounded-lg p-3 bg-primary/5">
                  <p className="text-sm whitespace-pre-wrap">{refinedText}</p>
                </ScrollArea>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="original" className="mt-4">
            <ScrollArea className="h-[350px] border rounded-lg p-4">
              <p className="text-sm whitespace-pre-wrap">{originalText}</p>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="refined" className="mt-4">
            <ScrollArea className="h-[350px] border border-primary/30 rounded-lg p-4 bg-primary/5">
              <p className="text-sm whitespace-pre-wrap">{refinedText}</p>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="gap-2">
            <X className="h-4 w-4" />
            Cancelar
          </Button>
          <Button variant="outline" onClick={onMerge} className="gap-2">
            <Merge className="h-4 w-4" />
            Mesclar (original + refinado)
          </Button>
          <Button onClick={onReplace} className="gap-2">
            <Check className="h-4 w-4" />
            Substituir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
