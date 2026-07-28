import { Snake, TeamInfo } from '../types/battlesnake';

export class TeamDetector {
  detectTeams(snakes: Snake[]): TeamInfo[] {
    const teamMap = new Map<string, Snake[]>();
    
    // Group snakes by team identifier (squad first, then color fallback)
    for (const snake of snakes) {
      const teamKey = this.getTeamKey(snake);
      if (!teamMap.has(teamKey)) {
        teamMap.set(teamKey, []);
      }
      teamMap.get(teamKey)!.push(snake);
    }
    
    // Create TeamInfo objects
    const teams: TeamInfo[] = [];
    for (const [teamKey, teamSnakes] of teamMap) {
      const totalLength = teamSnakes.reduce((sum, snake) => sum + snake.length, 0);
      teams.push({
        color: teamKey, // This represents the team identifier (squad or color)
        snakes: teamSnakes,
        totalLength
      });
    }
    
    return teams;
  }
  
  getTeammates(snake: Snake, allSnakes: Snake[]): Snake[] {
    const myTeamKey = TeamDetector.getTeamKey(snake);
    return allSnakes.filter(s => 
      s.id !== snake.id && 
      TeamDetector.getTeamKey(s) === myTeamKey
    );
  }
  
  getEnemySnakes(snake: Snake, allSnakes: Snake[]): Snake[] {
    const myTeamKey = TeamDetector.getTeamKey(snake);
    return allSnakes.filter(s => 
      TeamDetector.getTeamKey(s) !== myTeamKey
    );
  }

  // Single source of truth for team identity: squad field, then color, then
  // snake ID as a last resort. Exposed statically so other components (e.g. the
  // history viewer's games listing) can derive team membership from logged game
  // state without duplicating the rule.
  static getTeamKey(snake: Pick<Snake, 'id' | 'squad' | 'customizations'>): string {
    return snake.squad || snake.customizations?.color || snake.id;
  }

  private getTeamKey(snake: Snake): string {
    return TeamDetector.getTeamKey(snake);
  }
}