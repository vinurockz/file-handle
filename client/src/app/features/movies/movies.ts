import { Component } from '@angular/core';
import { MovieStudio, STUDIO } from './studio';

@Component({
  selector: 'app-movies',
  imports: [MovieStudio],
  providers: [{ provide: STUDIO, useValue: { collection: 'movies', title: 'Movies' } }],
  template: '<app-movie-studio />',
  styles: ':host { display: block; height: 100%; }',
})
export class Movies {}
