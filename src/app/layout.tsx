import type { Metadata } from "next";
import "@fontsource-variable/source-sans-3";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dashboard de Monica",
  description: "Base de datos y API analitica",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        {/*
          THESIS: Una sala de control comercial que prioriza decisiones legibles sobre decoracion de dashboard.
          OWN-WORLD: Blanco mineral, tinta azul profunda y una franja iridiscente muy contenida para estados activos.
          STORY: Monica elige un periodo, entiende el pulso de unidades y encuentra el stock que requiere atencion.
          FIRST VIEWPORT: Navegacion compacta, control de periodo y seis lecturas operativas antes de la evolucion.
          FORM: Operate / franja de lectura secuencial / seed 16860015.
          FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.
        */}
        {children}
      </body>
    </html>
  );
}
