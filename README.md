# Minuteurs Voice Satellite

Carte Lovelace pour retrouver et piloter les minuteurs d'une tablette [Kiosk Satellite](https://kiosksatellite.com) : ceux lancés à la voix (« Alexa, minuteur 10 minutes ») comme ceux lancés depuis la carte.

- liste des minuteurs avec décompte et anneau de progression ;
- pause / reprise, +1 min, −1 min, arrêt ;
- alarme terminée : bouton « Arrêter » ;
- lancement par durées rapides (1 min à 1 h) ou durée libre h : min : s, avec un nom facultatif ;
- mode `compact` (liste seule) pour un encart sur l'accueil.

Écrite pour l'Echo Show 8 1re génération : pas de dépendance, pas d'animation permanente, relecture de la liste seulement quand un minuteur change.

## Prérequis

Kiosk Satellite avec Voice Satellite activé. La carte utilise les actions ESPHome de la tablette (`esphome.<node>_vs_list_timers`, `_vs_start_timer`, `_vs_pause_timer`, `_vs_resume_timer`, `_vs_cancel_timer`, `_vs_add_time`, `_vs_remove_time`, `_vs_cancel`) et l'évènement `esphome.kiosk_satellite_timer`.

## Installation

HACS → menu ⋮ → Dépôts personnalisés → ce dépôt, catégorie « Dashboard », puis Télécharger. HACS ajoute la ressource `/hacsfiles/ha-minuteurs-card/minuteurs-card.js`.

## Configuration

```yaml
type: custom:minuteurs-card
node: ks_amzn_echo_show_8   # préfixe des actions ESPHome (Outils de développement → Actions)
title: Minuteurs            # "" pour masquer le titre
compact: false              # true : liste seule, sans création
presets: [1, 3, 5, 10, 15, 20, 30, 60]   # durées rapides, en minutes
```

`entity_prefix` (par défaut `node` sans `ks_`) sert à suivre `sensor.<prefix>_vs_timers` et `sensor.<prefix>_vs_next_timer`.

Encart d'accueil visible seulement quand un minuteur existe :

```yaml
type: custom:minuteurs-card
compact: true
visibility:
  - condition: numeric_state
    entity: sensor.amzn_echo_show_8_vs_timers
    above: 0
```

## Limite

Home Assistant retrouve un minuteur par son nom, ou par sa durée s'il n'en a pas : deux minuteurs anonymes de même durée sont indistinguables. La carte nomme donc « 3 min (2) » un second minuteur anonyme de 3 minutes.
