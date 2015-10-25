var http = require('http');
var WeatherBot = require('./weather-bot/main');

var PORT = process.env.PORT || 8080;

var userCount = 0;
var weather_bot = new WeatherBot("https://popping-inferno-367.firebaseio.com/tests/",
								 "bed10ba9e24eeb20");


http.createServer(function (request, response) {
    console.log('New connection');
    userCount++;

    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.write('Hello!\n');
    response.write('We have had '+userCount+' visits!\n');
    weather_bot.items().map(function(item){
    	response.write(item.id + " " + JSON.stringify(item.value) + "\n");
    });
    response.end();
}).listen(PORT);

console.log('listening on port ' + PORT);
console.log('Server started');
