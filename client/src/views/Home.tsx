import { useState } from "react";
import { useNavigate } from "react-router-dom";

export function Home() {
  const nav = useNavigate();
  const [code, setCode] = useState("");

  const go = (path: string) => {
    const c = code.trim().toUpperCase();
    nav(c ? `${path}?room=${c}` : path);
  };

  return (
    <div className="screen home">
      <div className="home-hero">
        <h1 className="logo">
          Arma<span>Bar</span>Games
        </h1>
        <p className="tagline">Le quiz qui anime vos soirées 🍻</p>
      </div>

      <div className="home-cards">
        <button className="home-card accent-host" onClick={() => nav("/host")}>
          <span className="home-card-emoji">🎛️</span>
          <span className="home-card-title">Créer une partie</span>
          <span className="home-card-sub">Animateur — ton téléphone pilote le jeu</span>
        </button>

        <div className="home-card accent-tv">
          <span className="home-card-emoji">📺</span>
          <span className="home-card-title">Ouvrir la TV</span>
          <span className="home-card-sub">L'écran partagé de la soirée</span>
          <div className="home-code-row">
            <input
              className="code-input"
              placeholder="CODE"
              maxLength={4}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button className="btn small" onClick={() => go("/tv")}>
              Afficher
            </button>
          </div>
        </div>

        <div className="home-card accent-play">
          <span className="home-card-emoji">📱</span>
          <span className="home-card-title">Rejoindre une équipe</span>
          <span className="home-card-sub">Scanne le QR sur la TV, ou entre le code</span>
          <div className="home-code-row">
            <input
              className="code-input"
              placeholder="CODE"
              maxLength={4}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button className="btn small" onClick={() => go("/play")}>
              Jouer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
