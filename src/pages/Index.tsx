import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Stats } from "@/components/Stats";
import { Features } from "@/components/Features";
import { Benefits } from "@/components/Benefits";
import { Pricing } from "@/components/Pricing";
import { Footer } from "@/components/Footer";
import { Testimonials } from "@/components/landing/Testimonials";
import { FAQ } from "@/components/landing/FAQ";
import { CTASection } from "@/components/landing/CTASection";
import { TrustBadges } from "@/components/landing/TrustBadges";
import { Integrations } from "@/components/landing/Integrations";
import { Helmet } from "react-helmet-async";

const Index = () => {
  return (
    <>
      <Helmet>
        <title>PsicoOne - Sistema Completo para Psicólogos | Gestão de Consultório</title>
        <meta 
          name="description" 
          content="PsicoOne é a plataforma #1 para psicólogos no Brasil. Prontuário com IA, agenda inteligente, teleatendimento, gestão financeira e muito mais. Teste grátis por 15 dias." 
        />
        <meta name="keywords" content="software para psicólogos, prontuário eletrônico, gestão de consultório, teleatendimento psicologia, agenda online psicólogo" />
        <link rel="canonical" href="https://psicoone.vercel.app" />
        
        {/* Open Graph */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="PsicoOne - Sistema Completo para Psicólogos" />
        <meta property="og:description" content="A plataforma que psicólogos amam. Automatize prontuários com IA, reduza faltas em 40% e libere 2 horas por dia." />
        <meta property="og:url" content="https://psicoone.vercel.app" />
        
        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="PsicoOne - Sistema Completo para Psicólogos" />
        <meta name="twitter:description" content="A plataforma que psicólogos amam. Automatize prontuários com IA, reduza faltas em 40% e libere 2 horas por dia." />
      </Helmet>
      
      <div className="min-h-screen bg-background overflow-x-hidden">
        <Header />
        <main>
          <Hero />
          <TrustBadges />
          <Stats />
          <Features />
          <Integrations />
          <Benefits />
          <Testimonials />
          <Pricing />
          <FAQ />
          <CTASection />
        </main>
        <Footer />
      </div>
    </>
  );
};

export default Index;
