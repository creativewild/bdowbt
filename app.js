var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var bodyParser = require('body-parser');
var fs = require('fs');
var sqlite3 = require('sqlite3').verbose();
var discord = require('discord.js');

var app = express();

// Import Settings
app.settings.servers = require('./settings/servers');
app.settings.channels = require('./settings/channels');
app.settings.bosses = require('./settings/bosses');

app.settings.whitelists = require('./settings/whitelists');
// app.settings.blacklists = require('./settings/blacklists');

app.settings.sqlCommands = require('./settings/sqlcommands');


var ALIVE_MAX_CONF = 2;
var DEAD_MAX_CONF = 2;
var BOT_TOKEN = 'MTcONTUONDk2MDkxODE1OTM3.CgEmCw.Y9fq3G4HXpbt44XdEs2bPdlemt4'; // Example token
var DB_FILE = 'data.sqlite';


// Initialise DB
function createTables() {
  db.run(app.settings.sqlCommands.createNotifys);
  db.run(app.settings.sqlCommands.createCommands);
}

var db = new sqlite3.Database(DB_FILE, createTables);

// Import Routes
var baseRoutes = require('./routes/index');
var serverRoutes = require('./routes/server');

// View Engine Setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', baseRoutes);
app.use('/server', serverRoutes);

// Catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// Error Handlers

// Development error handler, print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err,
    });
  });
}

// Production error handler, no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {},
  });
});

try {
  // Attempt to load existing status file
  var status = fs.readFileSync('./status.js', 'utf-8');
  app.status = JSON.parse(status);
} catch (err) {
  console.log('Could not load status file', err);

  app.status = new Object();
  for (var skey in app.settings.servers) {
    if (!app.settings.servers.hasOwnProperty(skey)) continue;

    app.status[skey] = new Object();
    var server = app.settings.servers[skey];

    for (var ckey in app.settings.channels.channels) {
      if (!app.settings.channels.channels.hasOwnProperty(ckey)) continue;

      app.status[skey][ckey] = new Object();
      var channel = app.settings.channels.channels[ckey];

      for (var bkey in app.settings.bosses) {
        if (!app.settings.bosses.hasOwnProperty(bkey)) continue;

        var boss = app.settings.channels.channels[bkey];

        app.status[skey][ckey][bkey] = {
          lastDied: null,
          statusChanged: null,
          status: 'black',
          //nextAliveMin: null,
          //nextAliveMax: null,
          reports: {
            'alive': {},
            'dead': {},
          },
        };
      }
    }
  }

  saveStatusToFile();
}

function saveStatusToFile() {
  fs.writeFile('./status.js', JSON.stringify(app.status, null, 2));
}

// Convert boss status to css class
function convertToCssStatus(status) {
  var cssStatus = 'black';
  if (status === 'alive') cssStatus = 'green';
  if (status === 'dead') cssStatus = 'red';

  return cssStatus;
}

/* STATUS HANDLING */
function addNotification(server, channel, boss, status, user) {
  var subTime = currentUnixTimestamp();

  // Server-wide spawn
  var tmpChannel = channel;
  var serverWide = app.settings.bosses[boss].serverWide;
  if (serverWide && status === 'alive') {
    tmpChannel = 0;
  }

  app.status[server][tmpChannel][boss]['reports'][status][user.id] = {
    submitted: subTime
  };

  var reports = app.status[server][tmpChannel][boss]['reports'][status];
  // Broadcast to all Socket.IO connections
  var numReports = Object.keys(reports).length;

  if ((status === 'alive' && numReports >= ALIVE_MAX_CONF) || (status === 'dead' && numReports >= DEAD_MAX_CONF)) {
    updateStatus(server, tmpChannel, boss, status, serverWide);
  }

  return numReports;
}

function currentUnixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function updateStatus(server, channel, boss, status, serverWide) {
  app.status[server][channel][boss]['reports']['dead'] = {};
  app.status[server][channel][boss]['reports']['alive'] = {};

  // Clear reports of death
  if (serverWide && status === 'alive') {
    for (var i = 0; i < app.settings.channels.channels.length; i++) {
      app.status[server][i][boss]['reports']['dead'] = {};
    }
  }

  var cssStatus = convertToCssStatus(status);

  if (serverWide && status === 'alive') {
    // Update all channels
    for (var i = 0; i < app.settings.channels.channels.length; i++) {
      app.status[server][i][boss]['status'] = cssStatus;
      app.status[server][i][boss]['statusChanged'] = currentUnixTimestamp();
    }
  } else {
    // Update specific channel
    app.status[server][channel][boss]['status'] = cssStatus;
    app.status[server][channel][boss]['statusChanged'] = currentUnixTimestamp();
  }

  // Create Message
  var message = '';
  var serverPrefix = app.settings.servers[server].prefix;

  // Select relevant message base
  if (serverWide && status === 'alive') {
    message = discordText.serverWide;
  } else if (status === 'alive') {
    message = discordText.bossAlive;
  } else {
    message = discordText.bossDead;
  }

  message = message.replace(/{server}/, app.settings.servers[server].name);
  message = message.replace(/{boss}/, app.settings.bosses[boss].name);
  message = message.replace(/{channel}/, app.settings.channels.channels[channel].replace(/{p}/, serverPrefix));

  // Notify specific channels on all servers
  var servers = bot.servers;
  servers.forEach(function(srvr) {
    srvr.channels.forEach(function(chnnl) {
      if (chnnl.name === server + '-bosses' && chnnl.type === 'text') {
        bot.sendMessage(chnnl, message);
      }
    });
  });

  // Notify any extra IDs
  var extra = app.settings.whitelists.notifyExtra;
  extra.forEach(function(channelId) {
    bot.sendMessage(channelId, message);
  })
  // Broadcast to server channel
}

// Get position of character within string
function getPosition(str, m, i) {
  return str.split(m, i).join(m).length;
}

function checkBossStatus() {
  var servers = app.status;
  var time = Date.now();

  for (var skey in servers) {
    if (servers.hasOwnProperty(skey)) {
      var channels = servers[skey];
      for (var ckey in channels) {
        if (channels.hasOwnProperty(ckey)) {
          var bosses = channels[ckey];
          for (var bkey in bosses) {
            if (bosses.hasOwnProperty(bkey)) {
              var boss = bosses[bkey];
              if (boss.status === 'green' && ((boss.statusChanged * 1000) + app.settings.bosses[bkey].despawnTime <= time)) {
                boss.status = 'black';
                boss.statusChanged = Math.floor(time / 1000);
              }
            }
          }
        }
      }
    }
  }
}


/* DISCORD BOT */
var discordText = require('./settings/discordtext');

var bot = new discord.Client({
  autoReconnect: true
});

bot.on('message', function(msg) {
  // If message is from self, do nothing
  if (msg.author === bot.user) return;

  var mention = bot.user.mention(); // String used to mention the bot
  var cmd = '';
  var cmdParams = '';
  var isMention = false;

  // Bot is mentioned at beginning of message
  if (msg.content.indexOf(bot.user.mention()) === 0) {
    if (msg.content.split(' ').length === 0) {
      // mention w/ no command
      // do nothing
    } else if (msg.content.split(' ').length === 1) {
      // mention w/ command
      cmd = msg.content.substring(mention.length + 1);
    } else if (msg.content.split(' ').length > 1) {
      // mention w/ cmd + params
      cmd = msg.content.substring(mention.length + 1, getPosition(msg.content, ' ', 2));
      cmdParams = msg.content.substring(mention.length + cmd.length + 1);
    }

    if (cmd[0] === ' ') cmd = cmd.substring(1);
    isMention = true;
  } else if (!msg.channel.server || app.settings.whitelists.channelNames.indexOf(msg.channel.name) !== -1) {
    if (msg.content.indexOf(' ') !== -1) {
      var firstSpace = msg.content.indexOf(' ');
      cmd = msg.content.substring(0, firstSpace);
    } else {
      cmd = msg.content;
    }
  } else {
    // Do nothing
    return;
  }

  if (msg.content.length > cmd.length && msg.content.indexOf(' ') !== -1) {
    if (isMention) {
      cmdParams = msg.content.substring(cmd.length + mention.length + 2);
    } else {
      cmdParams = msg.content.substring(cmd.length + 1);
    }
  }

  cmd = cmd.toLowerCase();
  cmdParams = cmdParams.toLowerCase();

  if (cmd === '' || cmd === 'help') {
    bot.sendMessage(msg.channel, discordText.about);
  }

  if (cmd === 'notify') {
    if (cmdParams === '') {
      bot.sendMessage(msg.channel, discordText.notifyHelp);
    } else {
      var paramsArr = cmdParams.split(' ');

      if (paramsArr.length < 4) {
        bot.sendMessage(msg.channel, discordText.notifyParamsMin);
        return;
      }

      var server = paramsArr[0];
      var channel = app.settings.channels.validChannels.indexOf(paramsArr[1]);
      var channel = (channel === -1)
        ? app.settings.channels.validChannelsShort.indexOf(paramsArr[1])
        : channel;
      var boss = paramsArr[2];
      var status = paramsArr[3];

      if (!app.settings.servers[server]) {
        bot.sendMessage(
          msg.channel,
          discordText.notifyWrongServer.replace(/{server}/, server));
          return;
      }

      if (channel === -1) {
        bot.sendMessage(
          msg.channel,
          discordText.notifyWrongChannel.replace(/{channel}/, paramsArr[1]));
          return;
      }

      if (!app.settings.bosses[boss]) {
        bot.sendMessage(
          msg.channel,
          discordText.notifyWrongBoss.replace(/{boss}/, boss));
          return;
      }

      if (status !== 'dead' && status !== 'alive') {
        bot.sendMessage(msg.channel, discordText.notifyWrongStatus);
        return;
      }

      /* Check if already Dead/Alive */
      if (app.status[server][channel][boss]['status'] === convertToCssStatus(status)) {
        bot.sendMessage(
          msg.channel,
          discordText.alreadyStatus.replace(/{status}/, status)
        );
        return;
      }

      /* SUCCESS */
      var message = '';

      if (status === 'dead') {
        message = discordText.deadConfirm;
      } else {
        message = discordText.aliveConfirm;
      }

      var confNum = addNotification(server, channel, boss, status, msg.author);
      var serverPrefix = app.settings.servers[server].prefix;

      message = message.replace(/{boss}/, app.settings.bosses[boss].name);
      message = message.replace(/{channel}/,
        app.settings.channels.channels[channel].replace(/{p}/, serverPrefix));
      message = message.replace(/{confNum}/, confNum);
      message = message.replace(/{maxConf}/, (status === 'alive')
        ? ALIVE_MAX_CONF
        : DEAD_MAX_CONF);

      bot.sendMessage(msg.channel, message);

      var stmt = db.prepare(app.settings.sqlCommands.insertNotify);
      stmt.run(msg.author.name, msg.author.id, server, channel, boss, status, currentUnixTimestamp(),
        function(err) {
          if (err) {
            console.log(err);
          } else {
            //console.log(this.lastID);
          }
        }
      );
    }
  }

  if (cmd === 'query') {
    if (cmdParams === '') {
      bot.sendMessage(msg.channel, discordText.queryHelp);
    } else {
      var paramsArr = cmdParams.split(' ');

      var server = paramsArr[0];
      var channel = (paramsArr.length > 1)
        ? app.settings.channels.validChannels.indexOf(paramsArr[1])
        : null;
      var channel = (channel === -1)
        ? app.settings.channels.validChannelsShort.indexOf(paramsArr[1])
        : channel;

      if (!app.settings.servers[server]) {
        bot.sendMessage(
          msg.channel,
          discordText.queryWrongServer.replace(/{server}/, server));
        return;
      }

      if (channel === -1 && channel !== null) {
        bot.sendMessage(
          msg.channel,
          discordText.queryWrongChannel.replace(/{channel}/, paramsArr[1]));
        return;
      }

      // Channel specific
      if (channel !== null) {
        var message = 'The following bosses are alive on ' + app.settings.servers[server].name + ':';
        var pool = [];

        var bosses = app.status[server][channel];

        for (var bkey in bosses) {
          if (bosses.hasOwnProperty(bkey)) {
            if (bosses[bkey].status === 'green') {
              pool.push(bkey);
            }
          }
        }

        if (pool.length > 0) {
          pool.forEach(function(bossKey) {
            message = message + '\r\n**' + app.settings.bosses[bossKey].name + '**';
          });
        } else {
          message = 'No bosses currently alive on ' + app.settings.servers[server].name;
        }
        bot.sendMessage(msg.channel, message);
      } else {
        // Server specific
        var message = 'Bosses are currently alive on the following channels:';
        var bosses = app.settings.bosses;

        var bossesAlive = 0;

        for (var bkey in bosses) {
          if (bosses.hasOwnProperty(bkey)) {
            var aliveOn = [];

            for (var ckey in app.status[server]) {
              if (app.status[server].hasOwnProperty(ckey)) {
                if (app.status[server][ckey][bkey].status === 'green') {
                  aliveOn.push(ckey);
                  bossesAlive++;
                }
              }
            }

            if (aliveOn.length > 0) {
              message = message + '\r\n**' + app.settings.bosses[bkey].name + ':** ';
              aliveOn.forEach(function(chnl, i) {
                var punctuation = (i !== 0)
                  ? ', '
                  : '';
                message = message
                  + punctuation
                  + app.settings.channels.channels[chnl].replace(
                    /{p}/, app.settings.servers[server].prefix);
              });
            }
          }
        }

        if (bossesAlive === 0) {
          bot.sendMessage(msg.channel , 'No bosses currently alive on ' + app.settings.servers[server].name);
        } else {
          bot.sendMessage(msg.channel, message);
        }
      }
    }
  }

  if (cmd === 'b4ckup') {
    saveStatusToFile();
    bot.sendMessage(msg.channel, 'Backed up status file.');
  }

  var stmt = db.prepare(app.settings.sqlCommands.insertCommand);
  stmt.run(msg.author.name, msg.author.id, cmd, cmdParams, currentUnixTimestamp(),
    function(err) {
      if (err) {
        console.log(err);
      } else {
        //console.log(this.lastID);
      }
    }
  );
});

bot.loginWithToken(
  botToken,
  function(error) {
    if (error) console.log(error);
  }
);

bot.on('ready', function() {
    console.log('Bot Serving. Setting status...');
    bot.setStatus('online', 'Love Games', function(err) {
      if (err) console.log(err);
      console.log('Status set.');
    });
});


// Backup timer
setInterval(saveStatusToFile, 30000); // 30 seconds
setInterval(checkBossStatus, 1200000); // 20 minutes


module.exports = app;
