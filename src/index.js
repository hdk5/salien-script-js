/**
 * MIT License
 *
 * Copyright (c) 2018 Alex Gabites
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const chalk = require('chalk');
const dateFormat = require('dateformat');
const delay = require('delay');
const fetch = require('fetch-retry');

const { version: pkgVersion } = require('../package.json');

// eslint-disable-next-line no-console
const logger = (...messages) => console.log(chalk.white(dateFormat(new Date(), '[HH:MM:ss]')), ...messages);

// eslint-disable-next-line no-console
const debug = message => console.log(`${JSON.stringify(message, 0, 2)}`);

const asyncForEach = async (_this, array, callback) => {
  for (let index = 0; index < array.length; index += 1) {
    await callback(array[index], index, array, _this);
  }
};

class SalienScriptException {
  constructor(message) {
    this.name = 'SalienScriptException';
    this.message = message;
  }
}

class SalienScriptRestart {
  constructor(message) {
    this.name = 'SalienScriptRestart';
    this.message = message;
  }
}

class SalienScript {
  constructor({ token, clan }) {
    this.token = token;
    this.clan = clan;

    this.maxRetries = 2;
    this.defaultDelayMs = 5000;
    this.defaultDelaySec = this.defaultDelayMs / 1000;

    this.tempPlanetId = null;

    this.currentPlanetId = null;
    this.knownPlanets = [];
  }

  async RequestAPI(method, params, maxRetries, additionalOptions = {}) {
    let url = `https://community.steam-api.com/${method}/v0001`;

    if (params) {
      url += '/?';

      params.forEach(param => {
        url += `${param}&`;
      });

      url = url.substring(0, url.length - 1);
    }

    const options = {
      retries: 3,
      retryDelay: 1000,
      headers: {
        Accept: '*/*',
        Origin: 'https://steamcommunity.com',
        Referer: 'https://steamcommunity.com/saliengame/play/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.87 Safari/537.36',
      },
      ...additionalOptions,
    };

    let request;
    let response;
    let retries = 0;

    while (!response && retries < maxRetries) {
      try {
        logger(chalk.blue(`Sending ${method}...`));
        request = await fetch(url, options);
        response = await request.json();
      } catch (e) {
        logger(chalk.bgRed(`${e.name}:`), chalk.red(`For ${method}`));
        debug(e);

        retries += 1;

        if (retries < maxRetries) {
          logger(chalk.yellow(`Retrying ${method} in ${this.defaultDelaySec} seconds...`));
        } else {
          throw new SalienScriptException(`Failed ${method} after ${retries} retries`);
        }

        await delay(this.defaultDelayMs);
      }
    }

    return response.response;
  }

  async ApiGetPlanets() {
    const response = await this.RequestAPI(
      'ITerritoryControlMinigameService/GetPlanets',
      ['active_only=1'],
      this.maxRetries,
    );
    return response.planets;
  }

  async ApiGetPlanet(planetId) {
    const response = await this.RequestAPI(
      'ITerritoryControlMinigameService/GetPlanet',
      [`id=${planetId}`, 'language=english'],
      this.maxRetries,
    );
    return response.planets[0];
  }

  async ApiGetPlayerInfo() {
    const response = await this.RequestAPI(
      'ITerritoryControlMinigameService/GetPlayerInfo',
      [`access_token=${this.token}`],
      this.maxRetries,
      { method: 'POST' },
    );
    return response;
  }

  async ApiRepresentClan(clanId) {
    const response = await this.RequestAPI(
      'ITerritoryControlMinigameService/RepresentClan',
      [`access_token=${this.token}`, `clanid=${clanId}`],
      this.maxRetries,
      { method: 'POST' },
    );
    return response;
  }

  async ApiLeaveGame(gameId) {
    const response = await this.RequestAPI(
      'IMiniGameService/LeaveGame',
      [`access_token=${this.token}`, `gameid=${gameId}`],
      this.maxRetries,
      { method: 'POST' },
    );
    return response;
  }

  async ApiJoinPlanet(planetId) {
    const response = await this.RequestAPI(
      'ITerritoryControlMinigameService/JoinPlanet',
      [`access_token=${this.token}`, `id=${planetId}`],
      this.maxRetries,
      { method: 'POST' },
    );
    return response;
  }

  async leaveCurrentGame(leaveCurrentPlanet) {
    const playerInfo = await this.ApiGetPlayerInfo();

    if (this.clan) {
      await this.ApiRepresentClan(this.clan);
    }

    if (playerInfo.active_zone_game) {
      logger(`Leaving ${playerInfo.active_zone_game}...`);

      try {
        await this.ApiLeaveGame(playerInfo.active_zone_game);
        logger('Success!');
      } catch (e) {
        throw new SalienScriptException(e);
      }
    }
  }

  async getFirstAvailablePlanet() {
    const planets = await this.ApiGetPlanets();

    if (!planets) {
      throw new SalienScriptException("Didn't find any planets.");
    }
  }

  async setupGame() {
    const planets = await this.ApiGetPlanets();

    if (!planets) {
      throw new SalienScriptException("Didn't find any planets.");
    }

    try {
      await asyncForEach(this, planets, async (planet, index, array, _this) => {
        _this.knownPlanets.push(planet.id);

        let zones;

        let hardZones = 0;
        let mediumZones = 0;
        let easyZones = 0;
        let unknownZones = 0;

        let hasBossZone = true;

        while (!zones) {
          zones = await _this.ApiGetPlanet(planet.id);
        }

        zones.zones.forEach(zone => {
          if ((zone.capture_progress && zone.capture_progress > 0.97) || zone.captured) {
            return;
          }

          if (zone.type === 4) {
            hasBossZone = true;
          } else if (zone.type !== 3) {
            logger(chalk.red(`!! Unknown zone type: ${zone.type}`));
          }

          switch (zone.difficulty) {
            case 3:
              hardZones += 1;
              break;
            case 2:
              mediumZones += 1;
              break;
            case 1:
              easyZones += 1;
              break;
            default:
              unknownZones += 1;
              break;
          }
        });

        const capturedPercent = Number(planet.state.capture_progress * 100).toFixed(2).toString();
        const planetName = planet.state.name.replace('#TerritoryControl_', '').split('_').join(' ');

        logger(`>> Planet: ${chalk.green(planet.id)} - Hard: ${chalk.yellow(hardZones)} - Medium: ${chalk.yellow(mediumZones)} - Easy: ${chalk.yellow(easyZones)} - Captured: ${chalk.yellow(capturedPercent)}% - Players: ${chalk.yellow(planet.state.current_players)} (${chalk.green(planetName)})`)

        if (unknownZones) {
          logger(`>> Unknown zones found: ${chalk.yellow(unknownZones)}`)
        }

        if (hasBossZone) {
          // eslint-disable-next-line no-param-reassign
          _this.currentPlanetId = planet.id;

          throw new SalienScriptException();
        }
      });
    } catch (e) {
      if (e.name === 'SalienScriptException') {
        logger(chalk.green('>> This planet has a boss zone, selecting this planet'));
      } else {
        debug(e);
        throw new SalienScriptException(e.message);
      }
    }

    console.log(this.currentPlanetId);



/*    
    // while we haven't got a current planet
    while (!this.currentPlanetId) {
      // TODO try follow preferences of the user (ie; planets with appid they want or specific name??)
      // TODO add an option to select going for the hardest difficulty only??

      // get first avaliable planet
      const planets = await this.ApiGetPlanets();

      if (!planets) {
        throw new SalienScriptException("Didn't find any planets.");
      }

      // debug(await planets);

      const firstOpen = planets.filter(planet => !planet.state.captured)[0];

      logger(chalk.green('[setupGame]'), 'First open planet id:', firstOpen.id);

      this.currentPlanetId = firstOpen.id;
    }
*/




    // while the current planet is not the same as the steam planet
    // while (this.currentPlanetId !== '') {
      // leave the current game
      // join the current planet
      // get the planet steam thinks we joined
    // }
  }

  async gameLoop() {
    throw new SalienScriptException(`gameLoop() not yet implemented`);

    // if last restart was greater than an hour ago
      // change planet

    // leave the current game to avoid getting stuck

    // while !zone
      // join first avaliable zone

    // if there are no zones
      // add planet to skip list
      // restart

    // if there are no hard zones left
      // restart

    // try to join a zone
      // restart if failed

    // log current zone info
      // planet
      // zone
      // top clans (if exists)

    // sleep for 110 seconds

    // send reportScore

    // if we get a new_score
      // log current user stats
  }

  async init() {
    try {
      logger(chalk.bgGreen(` Started SalienScript | Version: ${pkgVersion} `));

      await this.setupGame();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await this.gameLoop();
      }
    } catch (e) {
      logger(chalk.bgRed(`${e.name}:`), chalk.red(e.message));
      logger(chalk.bgMagenta(`Script will restart in ${this.defaultDelaySec} seconds...\n\n`));

      await delay(this.defaultDelayMs);

      this.init();
    }
  }
}

module.exports = SalienScript;
