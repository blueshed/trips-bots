/**
    This serves up the dist weather-ui directory
    and an admin page.

    It also runs the weather bot.
 */


var http = require('http');
var connect = require('connect');
var serveStatic = require('serve-static');

var WeatherBot = require('./weather-bot/main');

/**
    load environment variables if not in git hub
 */
require('dotenv').config({silent: true});

/**
    set up resources
 */
var PORT = process.env.PORT || 8080;

var userCount = 0;
var weather_bot = new WeatherBot(process.env.FB_PATH,
								 process.env.WU_API_KEY);

var app = connect();

/**
    handle admin request
 */
function handleAdmin(request, response){
    console.log('New connection');
    userCount++;

    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.write('Hello!\n');
    response.write('We have had '+userCount+' visits!\n');
    weather_bot.items().map(function(item){
        response.write(item.id + " " + JSON.stringify(item.value) + "\n");
    });
    response.end();
}


/**
    setup routes
 */
app.use('/admin', function adminHandler(request, response, next) {
  handleAdmin(request, response);
  next();
});

app.use(serveStatic('weather-ui/dist', {'index': ['index.html', 'index.htm']}));


/**
    start listening
 */
app.listen(PORT);

console.log('listening on port ' + PORT);
console.log('Server started');
